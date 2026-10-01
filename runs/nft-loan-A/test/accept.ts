// Deterministic acceptance suite (npm run accept).
// Fixed order, no wall-clock/network: in-process Fastify injection against an
// in-memory SQLite ledger seeded from src/state/fixtures.ts.
import { strict as assert } from 'node:assert';
import { loadConfig } from '../src/config.js';
import { Ledger } from '../src/state/ledger.js';
import { buildApp, AppContext } from '../src/app.js';
import { floorInterest } from '../src/kernel/money.js';
import { parseBps } from '../src/contract/parser.js';
import { DomainError, REASONS } from '../src/contract/errors.js';
import { FIXTURE_SEED, LENDER_POOL } from '../src/state/fixtures.js';

interface HttpResult { status: number; body: any; }

const failures: string[] = [];
let scenarioNo = 0;

function scenario(title: string) {
  scenarioNo += 1;
  console.log('\n==================================================================');
  console.log(`SCENARIO ${String(scenarioNo).padStart(2, '0')}: ${title}`);
  console.log('==================================================================');
}

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [FAIL] ${name} :: ${msg}`);
    failures.push(`S${scenarioNo} ${name}: ${msg}`);
  }
}

function showRequest(method: string, url: string, payload?: unknown) {
  console.log(`  --> ${method} ${url}`);
  if (payload !== undefined) console.log(`      req: ${JSON.stringify(payload)}`);
}
function showResponse(res: HttpResult) {
  console.log(`      <-- ${res.status} ${JSON.stringify(res.body)}`);
}

// Independent reference oracle (test-local; does not use kernel/money.ts).
function oracleInterest(principal: number, perTickBps: number, elapsedTicks: number): number {
  let product = 0n;
  for (let i = 0; i < elapsedTicks; i += 1) product += BigInt(principal) * BigInt(perTickBps);
  return Number(product / 1000n); // integer division floors for non-negative values
}

async function main() {
  const cfg = loadConfig({ dbPath: ':memory:' });
  const ledger = Ledger.openMemory(cfg);
  const ctx: AppContext = buildApp(cfg, ledger);
  const inject: any = ctx.app.inject.bind(ctx.app);

  const call = async (method: string, url: string, payload?: unknown): Promise<HttpResult> => {
    showRequest(method, url, payload);
    const res = await inject({ method, url, payload, headers: { 'content-type': 'application/json' } });
    const body = res.json() as any;
    showResponse({ status: res.statusCode, body });
    return { status: res.statusCode, body };
  };

  const INITIAL_CASH = Object.values(FIXTURE_SEED.balances).reduce((a, b) => a + b, 0);
  const NFT_TOTAL = Object.keys(FIXTURE_SEED.nftHolders).length;
  const assertConservation = (label: string) => {
    assert.equal(ledger.totalCash(), INITIAL_CASH, `cash not conserved at ${label}: ${ledger.totalCash()} != ${INITIAL_CASH}`);
    assert.equal(ledger.nftCount(), NFT_TOTAL, `nft count changed at ${label}`);
  };

  // ---- S01: independent interest arithmetic oracle ----
  scenario('interest math: 1003 x 5bps x 7 ticks -> floor(35.105)=35, due 1038');
  console.log('  oracle (test-local loop + bigint division):', oracleInterest(1003, 5, 7));
  console.log('  kernel (floorInterest):                    ', floorInterest(1003, 5, 7));
  check('oracle interest === 35', () => assert.equal(oracleInterest(1003, 5, 7), 35));
  check('kernel interest === 35', () => assert.equal(floorInterest(1003, 5, 7), 35));
  check('kernel matches independent oracle', () => assert.equal(floorInterest(1003, 5, 7), oracleInterest(1003, 5, 7)));
  check('due === 1038', () => assert.equal(1003 + floorInterest(1003, 5, 7), 1038));
  check('floor on another non-divisible case (1003*5/1000=5.015 -> 5)', () => {
    assert.equal(floorInterest(1003, 5, 1), 5);
    assert.equal(floorInterest(1003, 5, 1), oracleInterest(1003, 5, 1));
  });
  check('bps parser rejects rates outside 0..10000 as input errors', () => {
    assert.throws(() => parseBps(10001, 'x'), (e: unknown) => e instanceof DomainError && e.category === 'input' && e.reason === REASONS.bps_out_of_range);
    assert.throws(() => parseBps(-1, 'x'), (e: unknown) => e instanceof DomainError && e.reason === REASONS.bps_out_of_range);
  });

  // ---- S02: liquidation loan opened while NFT-DELTA valuation is 1000 ----
  scenario('open loan against NFT-DELTA at tick where valuation=1000 (ladder drops to 700 at tick>=10)');
  const r02 = await call('POST', '/loans/borrow', { borrower: 'alice', tokenId: 'NFT-DELTA', amount: 800 });
  let deltaLoanId = 0;
  check('borrow 800 returns 200', () => {
    assert.equal(r02.status, 200);
    assert.equal(r02.body.ok, true);
    deltaLoanId = r02.body.loanId;
  });
  check('opened at tick 1 and NFT locked in escrow', () => {
    assert.equal(r02.body.tick, 1);
    assert.equal(ledger.nftHolder('NFT-DELTA'), 'escrow');
    assert.equal(ledger.balance('alice'), 5000 + 800);
    assert.equal(ledger.balance(LENDER_POOL), 100000 - 800);
  });
  check('cash + NFT conservation after borrow', () => assertConservation('S02'));

  // ---- S03: collateral boundary ----
  scenario('borrow boundary: 1000 > 1000 x 8000bps = 800 -> 409; then 800 succeeds');
  const before = { cash: ledger.totalCash(), tick: ledger.getTick(), holder: ledger.nftHolder('NFT-ALPHA') };
  const r03bad = await call('POST', '/loans/borrow', { borrower: 'alice', tokenId: 'NFT-ALPHA', amount: 1000 });
  check('over-borrow rejected 409 insufficient_collateral', () => {
    assert.equal(r03bad.status, 409);
    assert.equal(r03bad.body.error.reason, REASONS.insufficient_collateral);
    assert.equal(r03bad.body.error.detail.maxAmount, 800);
  });
  check('failed borrow mutates nothing (tick/holder/cash unchanged)', () => {
    assert.equal(ledger.getTick(), before.tick);
    assert.equal(ledger.nftHolder('NFT-ALPHA'), before.holder);
    assert.equal(ledger.totalCash(), before.cash);
  });
  const r03ok = await call('POST', '/loans/borrow', { borrower: 'alice', tokenId: 'NFT-ALPHA', amount: 800 });
  check('exact boundary borrow 800 succeeds and escrows', () => {
    assert.equal(r03ok.status, 200);
    assert.equal(ledger.nftHolder('NFT-ALPHA'), 'escrow');
  });
  check('conservation after boundary borrow', () => assertConservation('S03'));

  // ---- S04: open interest-probe loan 1003, then move logical time with 6 fillers ----
  scenario('open 1003 loan at tick 3; six filler borrows make elapsed ticks = 7 at settlement');
  const r04 = await call('POST', '/loans/borrow', { borrower: 'alice', tokenId: 'NFT-GAMMA', amount: 1003 });
  let gammaLoanId = 0;
  check('borrow 1003 against valuation 2000 (max 1600) succeeds at tick 3', () => {
    assert.equal(r04.status, 200);
    assert.equal(r04.body.tick, 3);
    gammaLoanId = r04.body.loanId;
  });
  for (let i = 1; i <= 6; i += 1) {
    const r = await call('POST', '/loans/borrow', { borrower: 'alice', tokenId: `NFT-F${i}`, amount: 10 });
    check(`filler borrow #${i} at tick=${i + 3}`, () => assert.equal(r.status, 200));
  }
  check('global tick is now 9', () => assert.equal(ledger.getTick(), 9));

  // ---- S05: repayment boundary ----
  scenario('repay: 1037 < due 1038 -> 409 repayment_too_small; then 1040 with exactly 2 refunded');
  const preview = ledger.settlement(ledger.loan(gammaLoanId)!, 10);
  console.log(`  preview settlement at tick 10: ${JSON.stringify(preview)}`);
  check('preview at tick 10: elapsed 7, interest 35, due 1038 (matches oracle)', () => {
    assert.equal(preview.elapsedTicks, 7);
    assert.equal(preview.interest, 35);
    assert.equal(preview.due, 1038);
    assert.equal(preview.interest, oracleInterest(1003, 5, 7));
  });
  const aliceBefore = ledger.balance('alice');
  const poolBefore = ledger.balance(LENDER_POOL);
  const r05bad = await call('POST', `/loans/${gammaLoanId}/repay`, { payer: 'alice', amount: 1037 });
  check('short repay rejected 409 repayment_too_small', () => {
    assert.equal(r05bad.status, 409);
    assert.equal(r05bad.body.error.reason, REASONS.repayment_too_small);
    assert.equal(r05bad.body.error.detail.due, 1038);
  });
  check('short repay rolls back (tick unchanged at 9, NFT still escrowed)', () => {
    assert.equal(ledger.getTick(), 9);
    assert.equal(ledger.nftHolder('NFT-GAMMA'), 'escrow');
  });
  const r05ok = await call('POST', `/loans/${gammaLoanId}/repay`, { payer: 'alice', amount: 1040 });
  check('overpay 1040 settles at tick 10, due 1038, refund 2', () => {
    assert.equal(r05ok.status, 200);
    assert.equal(r05ok.body.tick, 10);
    assert.equal(r05ok.body.data.due, 1038);
    assert.equal(r05ok.body.data.interest, 35);
    assert.equal(r05ok.body.data.refund, 2);
  });
  check('balances move by exactly due; NFT redeemed to borrower', () => {
    assert.equal(ledger.balance('alice'), aliceBefore - 1038);
    assert.equal(ledger.balance(LENDER_POOL), poolBefore + 1038);
    assert.equal(ledger.nftHolder('NFT-GAMMA'), 'alice');
  });
  const r05again = await call('POST', `/loans/${gammaLoanId}/repay`, { payer: 'alice', amount: 1038 });
  check('second repay on settled loan -> 409 loan_already_settled', () => {
    assert.equal(r05again.status, 409);
    assert.equal(r05again.body.error.reason, REASONS.loan_already_settled);
  });
  check('conservation after repayment scenario', () => assertConservation('S05'));

  // ---- S06: concurrent double liquidation, commit-seq arbitration ----
  scenario('concurrent double liquidation of NFT-DELTA: exactly one 200 and one 409');
  const diag = await call('GET', `/loans/${deltaLoanId}`);
  check('pre-liquidation diagnostic: active, valuation 700, liquidatable', () => {
    assert.equal(diag.body.loan.status, 'active');
    assert.equal(diag.body.loan.settlement.valuation, 700);
    assert.equal(diag.body.loan.settlement.liquidatable, true);
  });
  const pair = await Promise.all([
    call('POST', `/loans/${deltaLoanId}/liquidate`, { liquidator: 'keeper-A' }),
    call('POST', `/loans/${deltaLoanId}/liquidate`, { liquidator: 'keeper-B' }),
  ]);
  const codes = pair.map((r) => r.status).sort((a, b) => a - b);
  check('HTTP codes are exactly {200, 409}', () => assert.deepEqual(codes, [200, 409]));
  const winner = pair.find((r) => r.status === 200)!;
  const loser = pair.find((r) => r.status === 409)!;
  check('winner: collateral to lender pool once, debt eliminated', () => {
    assert.equal(winner.body.data.tokenTransferredTo, LENDER_POOL);
    assert.equal(ledger.nftHolder('NFT-DELTA'), LENDER_POOL);
    assert.equal(ledger.loan(deltaLoanId)!.status, 'liquidated');
    assert.equal(ledger.loan(deltaLoanId)!.settled_tick, winner.body.tick);
  });
  check('loser: 409 loan_already_settled, defeated by earlier commit seq', () => {
    assert.equal(loser.body.error.reason, REASONS.loan_already_settled);
    const detail = loser.body.error.detail;
    assert.equal(detail.currentStatus, 'liquidated');
    assert.ok(detail.winnerCommitSeq < detail.commitSeq, `winner ${detail.winnerCommitSeq} < loser ${detail.commitSeq}`);
    assert.equal(detail.winnerCommitSeq, winner.body.commitSeq);
  });
  const l3 = await call('POST', `/loans/${deltaLoanId}/liquidate`, { liquidator: 'keeper-C' });
  check('third liquidation also 409 and cannot move collateral again', () => {
    assert.equal(l3.status, 409);
    assert.equal(l3.body.error.reason, REASONS.loan_already_settled);
    assert.equal(ledger.nftHolder('NFT-DELTA'), LENDER_POOL);
  });
  check('conservation after concurrent liquidations', () => assertConservation('S06'));

  // ---- S07: healthy loan cannot be liquidated (loan id 4 = NFT-F1) ----
  scenario('liquidation line not crossed: small debt vs valuation 100 -> 409');
  const healthyLoanId = 4;
  const r07 = await call('POST', `/loans/${healthyLoanId}/liquidate`, { liquidator: 'keeper-A' });
  check('healthy liquidation -> 409 liquidation_line_not_crossed', () => {
    assert.equal(r07.status, 409);
    assert.equal(r07.body.error.reason, REASONS.liquidation_line_not_crossed);
    assert.equal(r07.body.error.detail.valuation, 100);
    assert.ok(r07.body.error.detail.threshold <= 100);
  });
  check('healthy loan remains active and escrowed', () => {
    assert.equal(ledger.loan(healthyLoanId)!.status, 'active');
    assert.equal(ledger.nftHolder('NFT-F1'), 'escrow');
  });

  // ---- S08: 422 input errors with distinct reasons ----
  scenario('input validation: malformed amount/id -> 422 with distinct reasons');
  const badBody = await call('POST', '/loans/borrow', { borrower: 'alice', tokenId: 'NFT-BETA', amount: -5 });
  check('negative amount -> 422 amount_out_of_range', () => {
    assert.equal(badBody.status, 422);
    assert.equal(badBody.body.error.reason, REASONS.amount_out_of_range);
  });
  const badField = await call('POST', '/loans/borrow', { borrower: '', tokenId: 'NFT-BETA', amount: 10 });
  check('empty borrower -> 422 invalid_field', () => {
    assert.equal(badField.status, 422);
    assert.equal(badField.body.error.reason, REASONS.invalid_field);
  });
  const badId = await call('POST', '/loans/not-a-number/repay', { payer: 'alice', amount: 10 });
  check('non-numeric loan id -> 422 invalid_field', () => {
    assert.equal(badId.status, 422);
    assert.equal(badId.body.error.reason, REASONS.invalid_field);
  });
  const badFloat = await call('POST', '/loans/borrow', { borrower: 'alice', tokenId: 'NFT-BETA', amount: 1.5 });
  check('non-integer amount -> 422 invalid_field', () => {
    assert.equal(badFloat.status, 422);
    assert.equal(badFloat.body.error.reason, REASONS.invalid_field);
  });

  // ---- S09: other state conflicts ----
  scenario('state conflicts: unknown loan, token not held');
  const noLoan = await call('POST', '/loans/9999/repay', { payer: 'alice', amount: 10 });
  check('repay unknown loan -> 409 loan_not_found', () => {
    assert.equal(noLoan.status, 409);
    assert.equal(noLoan.body.error.reason, REASONS.loan_not_found);
  });
  const notHeld = await call('POST', '/loans/borrow', { borrower: 'bob', tokenId: 'NFT-BETA', amount: 10 });
  check('bob cannot borrow alice-held NFT -> 409 nft_not_held', () => {
    assert.equal(notHeld.status, 409);
    assert.equal(notHeld.body.error.reason, REASONS.nft_not_held);
    assert.equal(notHeld.body.error.detail.actualHolder, 'alice');
  });

  // ---- S10: diagnostics + commit log ----
  scenario('diagnostics: /diag/state exposes tick, balances, loans, ordered commit log');
  const stateRes = await call('GET', '/diag/state');
  check('conservation invariants and dense commit seqs', () => {
    const s = stateRes.body.state;
    assert.equal(s.totalCash, INITIAL_CASH);
    assert.equal(s.nftCount, NFT_TOTAL);
    const seqs = s.commitLog.map((c: any) => c.seq);
    for (let i = 1; i < seqs.length; i += 1) assert.equal(seqs[i], seqs[i - 1] + 1);
  });
  check('commit log: one ok and >=1 conflict for double liquidation', () => {
    const liq = stateRes.body.state.commitLog.filter((c: any) => c.loan_id === deltaLoanId && c.action === 'liquidate');
    assert.equal(liq.filter((c: any) => c.result === 'ok').length, 1);
    assert.ok(liq.filter((c: any) => c.result === 'conflict').length >= 1);
  });

  // ---- S11: final conservation ----
  scenario('final ledger conservation');
  check('total cash unchanged from seed', () => assert.equal(ledger.totalCash(), INITIAL_CASH));
  check('nft count unchanged; each token counted once', () => {
    assert.equal(ledger.nftCount(), NFT_TOTAL);
    const holders = ledger.db.prepare('SELECT holder, COUNT(*) AS c FROM nfts GROUP BY holder').all() as Array<{ holder: string; c: number }>;
    assert.equal(holders.reduce((a, h) => a + h.c, 0), NFT_TOTAL);
  });

  console.log();
  console.log('==================================================================');
  console.log('COMMIT LOG (ordered by internal seq; no wall-clock timestamps)');
  console.log('==================================================================');
  for (const row of ledger.listCommitLog()) {
    console.log(`seq=${String(row.seq).padStart(3)} tick=${String(row.tick).padStart(2)} ${row.action.padEnd(9)} loan=${String(row.loan_id).padStart(4)} result=${row.result.padEnd(8)} reason=${row.reason ?? '-'} run=${row.run_id} detail=${row.detail}`);
  }

  console.log();
  console.log('==================================================================');
  if (failures.length === 0) {
    console.log(`ALL SCENARIOS PASSED (${scenarioNo} scenarios)`);
    console.log('==================================================================');
    await ctx.app.close();
    process.exit(0);
  }
  console.log(`FAILED SCENARIOS: ${failures.length}`);
  for (const f of failures) console.log('  - ' + f);
  console.log('==================================================================');
  await ctx.app.close();
  process.exit(1);
}

main().catch((err) => {
  console.error('acceptance harness crashed (computation/setup failure):', err);
  process.exit(2);
});


