import { AppConfig } from '../config.js';
import { migrate } from './schema.js';
import { SqliteDb, isBusyError } from './sqlite.js';
import { FIXTURE_SEED, SeedInput } from './fixtures.js';
import { LoanStatus, SettlementView } from '../contract/types.js';
import { dueAmount, isBelowLiquidationLine } from '../kernel/money.js';
import { computationError, resourceError, REASONS } from '../contract/errors.js';

export interface LoanRow {
  id: number;
  borrower: string;
  token_id: string;
  principal: number;
  opened_tick: number;
  status: LoanStatus;
  settled_tick: number | null;
}

export interface CommitLogInput {
  runId: string;
  tick: number;
  action: string;
  loanId: number | null;
  result: 'ok' | 'conflict';
  reason: string | null;
  detail: Record<string, unknown>;
}

export class Ledger {
  readonly db: SqliteDb;
  readonly cfg: AppConfig;

  private constructor(db: SqliteDb, cfg: AppConfig) {
    this.db = db;
    this.cfg = cfg;
  }

  static open(cfg: AppConfig, seed: SeedInput = FIXTURE_SEED): Ledger {
    const db = new SqliteDb(cfg.dbPath);
    db.pragma(`busy_timeout = ${cfg.busTimeoutMs}`);
    migrate(db);
    const ledger = new Ledger(db, cfg);
    ledger.seedIfEmpty(seed);
    return ledger;
  }

  static openMemory(cfg: AppConfig, seed: SeedInput = FIXTURE_SEED): Ledger {
    const db = new SqliteDb(':memory:');
    db.pragma('busy_timeout = 10000');
    migrate(db);
    const ledger = new Ledger(db, cfg);
    ledger.seedIfEmpty(seed);
    return ledger;
  }

  close(): void {
    this.db.close();
  }

  private seedIfEmpty(seed: SeedInput): void {
    if (this.seeded()) return;
    this.runWrite(() => {
      const insBalance = this.db.prepare('INSERT INTO balances(account, amount) VALUES (?, ?)');
      for (const [account, amount] of Object.entries(seed.balances)) insBalance.run(account, amount);
      const insNft = this.db.prepare('INSERT INTO nfts(token_id, holder) VALUES (?, ?)');
      for (const [tokenId, holder] of Object.entries(seed.nftHolders)) insNft.run(tokenId, holder);
      const insTier = this.db.prepare('INSERT INTO valuation_tiers(token_id, start_tick, value) VALUES (?, ?, ?)');
      for (const [tokenId, tiers] of Object.entries(seed.valuationLadders)) {
        for (const tier of tiers) insTier.run(tokenId, tier.startTick, tier.value);
      }
      this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('seeded', 1)").run();
    });
  }

  private seeded(): boolean {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'seeded'").get() as { value: number } | undefined;
    return row?.value === 1;
  }

  getTick(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'tick'").get() as { value: number };
    return row.value;
  }

  bumpTick(): number {
    this.db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'tick'").run();
    return this.getTick();
  }

  private nextCommitSeq(): number {
    this.db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'commit_seq'").run();
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'commit_seq'").get() as { value: number };
    return row.value;
  }

  balance(account: string): number {
    const row = this.db.prepare('SELECT amount FROM balances WHERE account = ?').get(account) as { amount: number } | undefined;
    return row?.amount ?? 0;
  }

  nftHolder(tokenId: string): string | null {
    const row = this.db.prepare('SELECT holder FROM nfts WHERE token_id = ?').get(tokenId) as { holder: string } | undefined;
    return row?.holder ?? null;
  }

  loan(id: number): LoanRow | null {
    const row = this.db.prepare('SELECT id, borrower, token_id, principal, opened_tick, status, settled_tick FROM loans WHERE id = ?').get(id) as LoanRow | undefined;
    return row ?? null;
  }

  valuationAt(tokenId: string, tick: number): number {
    const row = this.db.prepare(
      'SELECT value FROM valuation_tiers WHERE token_id = ? AND start_tick <= ? ORDER BY start_tick DESC LIMIT 1',
    ).get(tokenId, tick) as { value: number } | undefined;
    if (!row) computationError(REASONS.computation_failed, 'no valuation tier defined for token at tick', { tokenId, tick });
    return row.value;
  }

  settlement(loan: LoanRow, tick = this.getTick()): SettlementView {
    const elapsed = tick - loan.opened_tick;
    if (elapsed < 0) computationError(REASONS.computation_failed, 'negative elapsed tick', { tick, openedTick: loan.opened_tick });
    const due = dueAmount(loan.principal, this.cfg.perTickBps, elapsed);
    const interest = due - loan.principal;
    const valuation = this.valuationAt(loan.token_id, tick);
    const threshold = Number((BigInt(due) * BigInt(this.cfg.liquidationLineBps)) / 10000n);
    return {
      tick,
      principal: loan.principal,
      elapsedTicks: elapsed,
      perTickBps: this.cfg.perTickBps,
      interest,
      due,
      valuation,
      liquidationThreshold: threshold,
      liquidatable: isBelowLiquidationLine(valuation, due, this.cfg.liquidationLineBps),
    };
  }

  totalCash(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM balances').get() as { total: number };
    return row.total;
  }

  nftCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM nfts').get() as { c: number };
    return row.c;
  }

  listCommitLog(): Array<{ seq: number; run_id: string; tick: number; action: string; loan_id: number | null; result: string; reason: string | null; detail: string }> {
    return this.db.prepare('SELECT seq, run_id, tick, action, loan_id, result, reason, detail FROM commit_log ORDER BY seq').all() as never[];
  }

  addBalance(account: string, delta: number): void {
    const next = this.balance(account) + delta;
    if (next < 0) computationError(REASONS.computation_failed, 'balance would go negative', { account, delta });
    this.db.prepare('INSERT INTO balances(account, amount) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET amount = excluded.amount').run(account, next);
  }

  transferNft(tokenId: string, toHolder: string): void {
    const res = this.db.prepare('UPDATE nfts SET holder = ? WHERE token_id = ?').run(toHolder, tokenId);
    if (res.changes !== 1) computationError(REASONS.computation_failed, 'nft transfer affected unexpected rows', { tokenId, changes: res.changes });
  }

  insertLoan(borrower: string, tokenId: string, principal: number, openedTick: number): number {
    const info = this.db.prepare('INSERT INTO loans(borrower, token_id, principal, opened_tick, status) VALUES (?, ?, ?, ?, ?)').run(borrower, tokenId, principal, openedTick, 'active');
    return Number(info.lastInsertRowid);
  }

  settleLoanIfActive(loanId: number, tick: number, status: LoanStatus, seq: number): boolean {
    const res = this.db.prepare("UPDATE loans SET status = ?, settled_tick = ?, settle_commit_seq = ? WHERE id = ? AND status = 'active'").run(status, tick, seq, loanId);
    return res.changes === 1;
  }

  appendCommitLog(input: CommitLogInput): number {
    const seq = this.nextCommitSeq();
    this.db.prepare('INSERT INTO commit_log(seq, run_id, tick, action, loan_id, result, reason, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      seq,
      input.runId,
      input.tick,
      input.action,
      input.loanId,
      input.result,
      input.reason,
      JSON.stringify(input.detail),
    );
    return seq;
  }

  winnerSeq(loanId: number): number | null {
    const row = this.db.prepare('SELECT settle_commit_seq FROM loans WHERE id = ?').get(loanId) as { settle_commit_seq: number | null } | undefined;
    return row?.settle_commit_seq ?? null;
  }

  // Single IMMEDIATE transaction per write request. Business conflicts are
  // committed (and recorded in commit_log); thrown errors roll the tx back.
  // On lock contention, retry a bounded number of times and then surface a
  // 503 resource_busy; the committer that gets the first BEGIN serializes all
  // writes, so commit_seq is a total order.
  runWrite<T>(fn: () => T): T {
    const maxAttempts = 200;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        this.db.beginImmediate();
        try {
          const result = fn();
          this.db.commit();
          return result;
        } catch (err) {
          try {
            this.db.rollback();
          } catch {
            // ignore rollback failure; surface the original error below
          }
          throw err;
        }
      } catch (err) {
        lastErr = err;
        if (isBusyError(err)) {
          continue;
        }
        throw err;
      }
    }
    resourceError(REASONS.resource_busy, 'database lock acquisition exhausted retries', {
      attempts: maxAttempts,
      cause: (lastErr as Error)?.message ?? 'unknown',
    });
  }
}


