import { test } from "node:test";
import assert from "node:assert/strict";
import { Kernel } from "../src/kernel/kernel.ts";
import { Ledger } from "../src/state/ledger.ts";
import { fixedFixture } from "../src/state/fixtures.ts";
import { FIXED_RIVAL_ORDER, runConcurrent } from "./harness.ts";
import type { Command } from "../src/contract/types.ts";

function setup() {
  const ledger = new Ledger(":memory:");
  ledger.loadFixture(fixedFixture());
  const kernel = new Kernel(ledger);
  return { ledger, kernel };
}

const purchase = (
  runId: string,
  seq: number,
  userId: string,
  seatCode: string,
  sessionId = "S1",
): Command => ({ kind: "purchase", runId, seq, sessionId, seatCode, userId });

test("concurrent purchase of one seat: exactly one wins, one seat_taken, funds conserved", () => {
  const { ledger, kernel } = setup();
  const runId = "run-race";
  const commands = [
    purchase(runId, 1, "alice", "A-1"),
    purchase(runId, 2, "bob", "A-1"),
  ];

  // Bob (index 1) is deliberately submitted first; arrival order must not decide.
  const results = runConcurrent(kernel, commands, FIXED_RIVAL_ORDER);

  assert.equal(results.length, 2);
  const winner = results.find((r) => r.ok);
  const loser = results.find((r) => !r.ok);
  assert.ok(winner, "exactly one success");
  assert.ok(loser, "exactly one failure");
  assert.equal(loser!.reason, "seat_taken");
  assert.equal(loser!.errorClass, "conflict");

  const ticket = ledger.findLiveTicket("S1", "A-1");
  assert.ok(ticket, "a ticket exists");
  assert.equal(ticket!.ticketId, "S1:A-1#g1");

  const liveCount = (ledger.db
    .prepare("SELECT COUNT(*) c FROM tickets WHERE session_id='S1' AND seat_code='A-1' AND status<>'voided'")
    .get() as { c: number }).c;
  assert.equal(liveCount, 1, "exactly one live ticket for the seat");

  // Money conservation: total balances across users unchanged minus one ticket price.
  const total = (ledger.db.prepare("SELECT SUM(balance) s FROM users").get() as { s: number }).s;
  assert.equal(total, 1000 + 1000 + 50 - 100);

  ledger.close();
});

test("purchase limit enforced then released after refund; seat resellable", () => {
  const { ledger, kernel } = setup();
  const runId = "run-limit";

  kernel.execute(purchase(runId, 1, "alice", "A-1"));
  kernel.execute(purchase(runId, 2, "alice", "A-2"));

  // Third purchase exceeds per-user limit of 2.
  const blocked = kernel.execute(purchase(runId, 3, "alice", "A-3"));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "purchase_limit_reached");

  assert.equal(ledger.balance("alice"), 800);

  // Refund A-1: releases both limit slot and seat, returns money.
  const refunded = kernel.execute({
    kind: "refund",
    runId,
    seq: 4,
    ticketId: "S1:A-1#g1",
    userId: "alice",
  });
  assert.equal(refunded.ok, true);
  assert.equal(ledger.balance("alice"), 900);
  assert.equal(ledger.heldCount("alice", "S1"), 1);

  // The released seat can now be sold to someone else.
  const resold = kernel.execute(purchase(runId, 5, "bob", "A-1"));
  assert.equal(resold.ok, true);
  assert.equal(ledger.findLiveTicket("S1", "A-1")?.holderUserId, "bob");

  // Alice also has a free limit slot again.
  const aliceBuy = kernel.execute(purchase(runId, 6, "alice", "A-3"));
  assert.equal(aliceBuy.ok, true);

  ledger.close();
});

test("ticket state machine: checked-in is terminal, holder enforced, conflicts distinguishable", () => {
  const { ledger, kernel } = setup();
  const runId = "run-fsm";

  kernel.execute(purchase(runId, 1, "alice", "A-1"));

  // Only the current holder can check in.
  const wrongHolder = kernel.execute({
    kind: "checkin",
    runId,
    seq: 2,
    ticketId: "S1:A-1#g1",
    userId: "bob",
  });
  assert.equal(wrongHolder.ok, false);
  assert.equal(wrongHolder.reason, "not_holder");

  // Transfer by non-holder rejected before check-in.
  const badTransfer = kernel.execute({
    kind: "transfer",
    runId,
    seq: 3,
    ticketId: "S1:A-1#g1",
    fromUserId: "bob",
    toUserId: "carol",
  });
  assert.equal(badTransfer.ok, false);
  assert.equal(badTransfer.reason, "not_holder");

  // Holder transfers successfully.
  const transferred = kernel.execute({
    kind: "transfer",
    runId,
    seq: 4,
    ticketId: "S1:A-1#g1",
    fromUserId: "alice",
    toUserId: "bob",
  });
  assert.equal(transferred.ok, true);
  assert.equal(ledger.getTicket("S1:A-1#g1")?.holderUserId, "bob");

  // New holder checks in: terminal state.
  const checked = kernel.execute({
    kind: "checkin",
    runId,
    seq: 5,
    ticketId: "S1:A-1#g1",
    userId: "bob",
  });
  assert.equal(checked.ok, true);
  assert.equal(ledger.getTicket("S1:A-1#g1")?.status, "checked_in");

  const afterCheckinTransfer = kernel.execute({
    kind: "transfer",
    runId,
    seq: 6,
    ticketId: "S1:A-1#g1",
    fromUserId: "bob",
    toUserId: "carol",
  });
  assert.equal(afterCheckinTransfer.ok, false);
  assert.equal(afterCheckinTransfer.reason, "already_checked_in");

  const afterCheckinRefund = kernel.execute({
    kind: "refund",
    runId,
    seq: 7,
    ticketId: "S1:A-1#g1",
    userId: "bob",
  });
  assert.equal(afterCheckinRefund.ok, false);
  assert.equal(afterCheckinRefund.reason, "already_checked_in");

  const repeatCheckin = kernel.execute({
    kind: "checkin",
    runId,
    seq: 8,
    ticketId: "S1:A-1#g1",
    userId: "bob",
  });
  assert.equal(repeatCheckin.ok, false);
  assert.equal(repeatCheckin.reason, "already_checked_in");

  // Holder unchanged and ownership history still records alice -> bob.
  const ticket = ledger.getTicket("S1:A-1#g1");
  assert.equal(ticket?.holderUserId, "bob");
  const history = ledger.ownershipHistory("S1:A-1#g1");
  const transferEvent = history.find((h) => h.action === "transfer");
  assert.equal(transferEvent?.fromUserId, "alice");
  assert.equal(transferEvent?.toUserId, "bob");

  ledger.close();
});

test("voided ticket cannot be transferred or checked in, and is distinguishable", () => {
  const { ledger, kernel } = setup();
  const runId = "run-void";
  kernel.execute(purchase(runId, 1, "alice", "A-1"));
  const refund = kernel.execute({
    kind: "refund",
    runId,
    seq: 2,
    ticketId: "S1:A-1#g1",
    userId: "alice",
  });
  assert.equal(refund.ok, true);

  const transfer = kernel.execute({
    kind: "transfer",
    runId,
    seq: 3,
    ticketId: "S1:A-1#g1",
    fromUserId: "alice",
    toUserId: "bob",
  });
  assert.equal(transfer.ok, false);
  assert.equal(transfer.reason, "voided");

  const checkin = kernel.execute({
    kind: "checkin",
    runId,
    seq: 4,
    ticketId: "S1:A-1#g1",
    userId: "alice",
  });
  assert.equal(checkin.ok, false);
  assert.equal(checkin.reason, "voided");

  const secondRefund = kernel.execute({
    kind: "refund",
    runId,
    seq: 5,
    ticketId: "S1:A-1#g1",
    userId: "alice",
  });
  assert.equal(secondRefund.ok, false);
  assert.equal(secondRefund.reason, "voided");

  ledger.close();
});

