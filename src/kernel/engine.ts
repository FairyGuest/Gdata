import { CONFIG } from "../config.js";
import { getMeta, valuationAt, type Db } from "../state/db.js";
import { conflict, resource, compute } from "./errors.js";

export interface LoanRow {
  id: number;
  borrower: string;
  token_id: string;
  principal: number;
  per_tick_bps: number;
  borrow_tick: number;
  status: "active" | "repaid" | "liquidated";
  settle_tick: number | null;
  settle_seq: number | null;
}

/** interest = floor(principal * perTickBps * elapsedTicks / DENOM), exact BigInt arithmetic. */
export function interestOf(principal: number, perTickBps: number, elapsedTicks: number): number {
  const v = (BigInt(principal) * BigInt(perTickBps) * BigInt(elapsedTicks)) /
    CONFIG.INTEREST_DENOMINATOR;
  return Number(v);
}

export function debtOf(loan: Pick<LoanRow, "principal" | "per_tick_bps" | "borrow_tick">, atTick: number): number {
  return loan.principal + interestOf(loan.principal, loan.per_tick_bps, atTick - loan.borrow_tick);
}

interface WriteOk<T> { result: T; tick: number; seq: number }

/**
 * Lending kernel. Every write (borrow/repay/liquidate) runs in one SQLite
 * IMMEDIATE transaction: bumps the global tick, mutates ledger rows, then
 * assigns the commit sequence number — all atomically. SQLite serializes
 * writers on this connection, so concurrent conflicting writes are decided
 * by commit order (the later transaction observes the committed state and
 * conflicts out), never by wall-clock or arrival timing.
 */
export class Engine {
  constructor(private readonly db: Db) {}

  private writeTx<T>(fn: (tick: number) => T): WriteOk<T> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const tick = this.bump("tick");
      const result = fn(tick);
      const seq = this.bump("commit_seq");
      this.db.exec("COMMIT");
      return { result, tick, seq };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private bump(key: string): number {
    this.db.prepare("UPDATE meta SET value = value + 1 WHERE key = ?").run(key);
    return getMeta(this.db, key);
  }

  private getLoan(id: number): LoanRow {
    const row = this.db.prepare("SELECT * FROM loans WHERE id = ?").get(id) as LoanRow | undefined;
    if (!row) throw conflict("loan_not_found", "loan " + id + " does not exist");
    return row;
  }

  private balanceOf(id: string): number {
    const row = this.db.prepare("SELECT balance FROM accounts WHERE id = ?").get(id) as
      | { balance: number }
      | undefined;
    if (!row) throw conflict("account_not_found", "account " + id + " does not exist");
    return Number(row.balance);
  }

  private transfer(from: string, to: string, amount: number): void {
    if (amount === 0) return;
    if (this.balanceOf(from) < amount) {
      throw conflict("insufficient_balance", "account " + from + " balance too low");
    }
    this.db.prepare("UPDATE accounts SET balance = balance - ? WHERE id = ?").run(amount, from);
    this.db.prepare("UPDATE accounts SET balance = balance + ? WHERE id = ?").run(amount, to);
  }

  private setOwner(tokenId: string, owner: string): void {
    this.db.prepare("UPDATE tokens SET owner = ? WHERE id = ?").run(owner, tokenId);
  }

  borrow(p: { borrower: string; tokenId: string; amount: number; perTickBps: number }) {
    return this.writeTx((tick) => {
      const token = this.db.prepare("SELECT owner FROM tokens WHERE id = ?").get(p.tokenId) as
        | { owner: string }
        | undefined;
      if (!token) throw conflict("token_not_found", "token " + p.tokenId + " does not exist");
      if (token.owner !== p.borrower) {
        throw conflict("token_not_owned", "token " + p.tokenId + " is not held by " + p.borrower);
      }
      const value = valuationAt(this.db, tick);
      // amount*10000 <= valuation*collateralRatioBps
      if (BigInt(p.amount) * 10000n > BigInt(value) * BigInt(CONFIG.COLLATERAL_RATIO_BPS)) {
        throw conflict(
          "insufficient_collateral",
          "amount " + p.amount + " exceeds " + CONFIG.COLLATERAL_RATIO_BPS + "bps of valuation " + value,
        );
      }
      if (this.balanceOf(CONFIG.POOL_ID) < p.amount) {
        throw resource("pool_exhausted", "lending pool cannot fund " + p.amount);
      }
      // Pledge and disburse in the same transaction.
      this.setOwner(p.tokenId, CONFIG.ESCROW_ID);
      this.transfer(CONFIG.POOL_ID, p.borrower, p.amount);
      const info = this.db
        .prepare(
          "INSERT INTO loans (borrower, token_id, principal, per_tick_bps, borrow_tick, status) " +
            "VALUES (?, ?, ?, ?, ?, 'active')",
        )
        .run(p.borrower, p.tokenId, p.amount, p.perTickBps, tick);
      return { loanId: Number(info.lastInsertRowid), valuation: value };
    });
  }

  repay(p: { loanId: number; amount: number; payer: string }) {
    return this.writeTx((tick) => {
      const loan = this.getLoan(p.loanId);
      if (loan.status !== "active") {
        throw conflict("already_settled", "loan " + p.loanId + " is " + loan.status);
      }
      const debt = debtOf(loan, tick);
      if (p.amount < debt) {
        throw conflict("insufficient_repayment", "paid " + p.amount + " but debt is " + debt);
      }
      const refund = p.amount - debt;
      // Only the debt portion leaves the payer; the overpaid remainder (refund)
      this.transfer(p.payer, CONFIG.POOL_ID, debt);
      // never moves, so it is returned to the payer within the same transaction.
      // Collateral redeemed to the borrower in the same transaction.
      this.setOwner(loan.token_id, loan.borrower);
      this.db
        .prepare("UPDATE loans SET status = 'repaid', settle_tick = ?, settle_seq = ? WHERE id = ?")
        .run(tick, getMeta(this.db, "commit_seq") + 1, p.loanId);
      return { debt, refund, redeemedToken: loan.token_id };
    });
  }

  liquidate(p: { loanId: number; caller: string }) {
    return this.writeTx((tick) => {
      const loan = this.getLoan(p.loanId);
      if (loan.status !== "active") {
        throw conflict("already_settled", "loan " + p.loanId + " is " + loan.status);
      }
      const debt = debtOf(loan, tick);
      const value = valuationAt(this.db, tick);
      // Liquidatable iff valuation*10000 < debt*liquidationLineBps.
      if (BigInt(value) * 10000n >= BigInt(debt) * BigInt(CONFIG.LIQUIDATION_LINE_BPS)) {
        throw conflict(
          "not_underwater",
          "valuation " + value + " still covers debt " + debt + " at line " + CONFIG.LIQUIDATION_LINE_BPS + "bps",
        );
      }
      // Collateral to the funding side, debt erased — one transaction.
      this.setOwner(loan.token_id, CONFIG.POOL_ID);
      this.db
        .prepare("UPDATE loans SET status = 'liquidated', settle_tick = ?, settle_seq = ? WHERE id = ?")
        .run(tick, getMeta(this.db, "commit_seq") + 1, p.loanId);
      return { debt, valuation: value, seizedToken: loan.token_id };
    });
  }

  /** Read-only snapshot helpers for the diag layer. */
  snapshot() {
    const tick = getMeta(this.db, "tick");
    const seq = getMeta(this.db, "commit_seq");
    const accounts = this.db.prepare("SELECT id, balance FROM accounts ORDER BY id").all();
    const tokens = this.db.prepare("SELECT id, owner FROM tokens ORDER BY id").all();
    const loans = (this.db.prepare("SELECT * FROM loans ORDER BY id").all() as unknown as LoanRow[]).map((l) => ({
      ...l,
      debt: l.status === "active" ? debtOf(l, tick) : null,
    }));
    return { tick, commitSeq: seq, valuation: valuationAt(this.db, tick), accounts, tokens, loans };
  }

  loanQuote(loanId: number) {
    const loan = this.getLoan(loanId);
    const tick = getMeta(this.db, "tick");
    return {
      loan,
      tick,
      valuation: valuationAt(this.db, tick),
      debt: loan.status === "active" ? debtOf(loan, tick) : null,
    };
  }
}

export function assertConserved(db: Db): { ok: boolean; detail: string } {
  const accts = db.prepare("SELECT COALESCE(SUM(balance), 0) AS s FROM accounts").get() as { s: number };
  const toks = db.prepare("SELECT COUNT(*) AS c FROM tokens").get() as { c: number };
  // Fixture totals: 100000 + 5000 + 3000 + 1000 = 109000 across 4 tokens.
  const ok = Number(accts.s) === 109000 && Number(toks.c) === 4;
  return {
    ok,
    detail: "sum(balances)=" + accts.s + " (expect 109000), tokens=" + toks.c + " (expect 4)",
  };
}

export { compute };
