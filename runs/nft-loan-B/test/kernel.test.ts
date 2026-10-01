import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, seedFixtures, getMeta } from "../src/state/db.js";
import { Engine, assertConserved } from "../src/kernel/engine.js";
import { KernelError } from "../src/kernel/errors.js";

function fresh() {
  const db = openDb();
  seedFixtures(db);
  return { db, engine: new Engine(db) };
}

function expectConflict(fn: () => unknown, reason: string) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof KernelError, "expected KernelError, got " + e);
    assert.equal(e.kind, "conflict");
    assert.equal(e.reason, reason);
    return;
  }
  assert.fail("expected conflict " + reason);
}

test("borrow escrows the token and disburses atomically", () => {
  const { engine } = fresh();
  const r = engine.borrow({ borrower: "alice", tokenId: "nft-1", amount: 4000, perTickBps: 5 });
  assert.equal(r.tick, 1);
  const s = engine.snapshot();
  assert.equal((s.tokens as Array<{ id: string; owner: string }>).find((t) => t.id === "nft-1")!.owner, "escrow");
  const bal = Object.fromEntries((s.accounts as Array<{ id: string; balance: number }>).map((a) => [a.id, a.balance]));
  assert.equal(bal.alice, 9000);
  assert.equal(bal.lender, 96000);
});

test("over-borrow is rejected with insufficient_collateral", () => {
  const { engine } = fresh();
  expectConflict(
    () => engine.borrow({ borrower: "alice", tokenId: "nft-1", amount: 5001, perTickBps: 5 }),
    "insufficient_collateral",
  );
});

test("repay: underpayment 409, overpayment refunded, token redeemed, re-repay 409", () => {
  const { db, engine } = fresh();
  const b = engine.borrow({ borrower: "alice", tokenId: "nft-1", amount: 1003, perTickBps: 5 });
  // Advance logical time by fixture control (not the production write path).
  db.prepare("UPDATE meta SET value = ? WHERE key = 'tick'").run(b.tick + 6);
  const before = engine.snapshot();
  const aliceBefore = (before.accounts as Array<{ id: string; balance: number }>).find((a) => a.id === "alice")!.balance;

  expectConflict(() => engine.repay({ loanId: b.result.loanId, amount: 1037, payer: "alice" }), "insufficient_repayment");

  const r = engine.repay({ loanId: b.result.loanId, amount: 1100, payer: "alice" });
  assert.equal(r.result.debt, 1038); // 1003 + floor(1003*5*7/1000)
  assert.equal(r.result.refund, 62);
  const after = engine.snapshot();
  const bal = Object.fromEntries((after.accounts as Array<{ id: string; balance: number }>).map((a) => [a.id, a.balance]));
  assert.equal(bal.alice, aliceBefore - 1038); // only the debt portion left alice
  assert.equal((after.tokens as Array<{ id: string; owner: string }>).find((t) => t.id === "nft-1")!.owner, "alice");

  expectConflict(() => engine.repay({ loanId: b.result.loanId, amount: 2000, payer: "alice" }), "already_settled");
  assert.ok(assertConserved(db).ok);
});

test("liquidation: not-underwater 409, underwater seizes once, double liquidate -> one 409", () => {
  const { db, engine } = fresh();
  const b = engine.borrow({ borrower: "alice", tokenId: "nft-1", amount: 4000, perTickBps: 0 });
  expectConflict(() => engine.liquidate({ loanId: b.result.loanId, caller: "carol" }), "not_underwater");
  // Drive the tick up the ladder until valuation 1000 (tick >= 25): 1000*10000 < 4000*11000.
  db.prepare("UPDATE meta SET value = 25 WHERE key = 'tick'").run();
  const win = engine.liquidate({ loanId: b.result.loanId, caller: "carol" });
  assert.equal(win.result.seizedToken, "nft-1");
  // Second liquidation (the "loser" of a concurrent pair) conflicts on committed state.
  expectConflict(() => engine.liquidate({ loanId: b.result.loanId, caller: "bob" }), "already_settled");
  const s = engine.snapshot();
  assert.equal((s.tokens as Array<{ id: string; owner: string }>).find((t) => t.id === "nft-1")!.owner, "lender");
  assert.ok(assertConserved(db).ok);
  // Commit sequence strictly increased across settled writes.
  assert.ok(getMeta(db, "commit_seq") >= 2);
});

test("pool exhaustion maps to 503 resource", () => {
  const { db, engine } = fresh();
  // Fixture control: shrink the pool below the next ask.
  db.prepare("UPDATE accounts SET balance = 100 WHERE id = 'lender'").run();
  try {
    engine.borrow({ borrower: "bob", tokenId: "nft-4", amount: 5000, perTickBps: 0 });
    assert.fail("expected pool_exhausted");
  } catch (e) {
    assert.ok(e instanceof KernelError);
    assert.equal(e.kind, "resource");
    assert.equal(e.reason, "pool_exhausted");
  }
});
