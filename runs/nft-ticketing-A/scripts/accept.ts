import { Kernel } from "../src/kernel/kernel.ts";
import { Ledger } from "../src/state/ledger.ts";
import { fixedFixture } from "../src/state/fixtures.ts";
import type { Command, CommandResult } from "../src/contract/types.ts";

let failures = 0;
let step = 0;

function log(title: string) {
  console.log(`\n=== ${title} ===`);
}

function show(runId: string, cmd: Command, result: CommandResult) {
  console.log(`  [${runId} #${cmd.seq}] ${cmd.kind}`, JSON.stringify(cmd));
  console.log(`      -> ok=${result.ok} commitSeq=${result.commitSeq}`, result.ok ? "" : `reason=${result.reason}`);
}

function check(name: string, cond: boolean, rationale: string) {
  step += 1;
  if (cond) {
    console.log(`  PASS [${step}] ${name} (${rationale})`);
  } else {
    failures += 1;
    console.log(`  FAIL [${step}] ${name} (${rationale})`);
  }
}

const purchase = (
  runId: string,
  seq: number,
  userId: string,
  seatCode: string,
): Command => ({ kind: "purchase", runId, seq, sessionId: "S1", seatCode, userId });

// ---- Scenario 1: concurrent race for one seat ----
log("Scenario 1: concurrent purchase of seat A-1 (fixed order: bob submitted first)");
{
  const ledger = new Ledger(":memory:");
  ledger.loadFixture(fixedFixture());
  const kernel = new Kernel(ledger);
  const runId = "accept-race";
  const cmds = [purchase(runId, 1, "alice", "A-1"), purchase(runId, 2, "bob", "A-1")];
  // Submit bob (index 1) first to prove arrival order does not win.
  const order = [1, 0];
  const results: CommandResult[] = [];
  for (const i of order) {
    const r = kernel.execute(cmds[i]);
    show(runId, cmds[i], r);
    results.push(r);
  }
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.filter((r) => !r.ok).length;
  const loser = results.find((r) => !r.ok);
  check("exactly one 200/ok", okCount === 1, `okCount=${okCount}`);
  check("exactly one conflict", failCount === 1, `failCount=${failCount}`);
  check("loser reason is seat_taken", loser?.reason === "seat_taken", `reason=${loser?.reason}`);
  const live = (ledger.db
    .prepare("SELECT COUNT(*) c FROM tickets WHERE session_id='S1' AND seat_code='A-1' AND status<>'voided'")
    .get() as { c: number }).c;
  check("exactly one live ticket", live === 1, `live=${live}`);
  const total = (ledger.db.prepare("SELECT SUM(balance) s FROM users").get() as { s: number }).s;
  check("funds conserved", total === 1000 + 1000 + 50 - 100, `totalBalance=${total}`);
  console.log("  run attempts:", JSON.stringify(ledger.attempts(runId)));
  ledger.close();
}

// ---- Scenario 2: purchase limit + refund release ----
log("Scenario 2: purchase limit then refund releases seat and limit");
{
  const ledger = new Ledger(":memory:");
  ledger.loadFixture(fixedFixture());
  const kernel = new Kernel(ledger);
  const runId = "accept-limit";
  const r1 = kernel.execute(purchase(runId, 1, "alice", "A-1"));
  show(runId, purchase(runId, 1, "alice", "A-1"), r1);
  kernel.execute(purchase(runId, 2, "alice", "A-2"));
  const blocked = kernel.execute(purchase(runId, 3, "alice", "A-3"));
  show(runId, purchase(runId, 3, "alice", "A-3"), blocked);
  check("third purchase 409 purchase_limit_reached", blocked.ok === false && blocked.reason === "purchase_limit_reached", `reason=${blocked.reason}`);
  const refund = kernel.execute({ kind: "refund", runId, seq: 4, ticketId: "S1:A-1#g1", userId: "alice" });
  check("refund succeeds", refund.ok === true, `commitSeq=${refund.commitSeq}`);
  check("balance refunded", ledger.balance("alice") === 900, `balance=${ledger.balance("alice")}`);
  check("held count released", ledger.heldCount("alice", "S1") === 1, `held=${ledger.heldCount("alice", "S1")}`);
  const resold = kernel.execute(purchase(runId, 5, "bob", "A-1"));
  show(runId, purchase(runId, 5, "bob", "A-1"), resold);
  check("released seat resold", resold.ok === true && ledger.findLiveTicket("S1", "A-1")?.holderUserId === "bob", "holder=bob");
  const aliceAgain = kernel.execute(purchase(runId, 6, "alice", "A-3"));
  check("alice limit slot released", aliceAgain.ok === true, `ok=${aliceAgain.ok}`);
  ledger.close();
}

// ---- Scenario 3: state machine boundaries ----
log("Scenario 3: checked-in is terminal and conflict reasons are distinguishable");
{
  const ledger = new Ledger(":memory:");
  ledger.loadFixture(fixedFixture());
  const kernel = new Kernel(ledger);
  const runId = "accept-fsm";
  kernel.execute(purchase(runId, 1, "alice", "A-1"));

  const notHolderTransfer = kernel.execute({ kind: "transfer", runId, seq: 2, ticketId: "S1:A-1#g1", fromUserId: "bob", toUserId: "carol" });
  check("transfer by non-holder -> not_holder", notHolderTransfer.ok === false && notHolderTransfer.reason === "not_holder", `reason=${notHolderTransfer.reason}`);

  kernel.execute({ kind: "transfer", runId, seq: 3, ticketId: "S1:A-1#g1", fromUserId: "alice", toUserId: "bob" });
  const notHolderCheckin = kernel.execute({ kind: "checkin", runId, seq: 4, ticketId: "S1:A-1#g1", userId: "alice" });
  check("checkin by non-holder -> not_holder", notHolderCheckin.ok === false && notHolderCheckin.reason === "not_holder", `reason=${notHolderCheckin.reason}`);

  kernel.execute({ kind: "checkin", runId, seq: 5, ticketId: "S1:A-1#g1", userId: "bob" });
  const t = kernel.execute({ kind: "transfer", runId, seq: 6, ticketId: "S1:A-1#g1", fromUserId: "bob", toUserId: "carol" });
  const r = kernel.execute({ kind: "refund", runId, seq: 7, ticketId: "S1:A-1#g1", userId: "bob" });
  const c = kernel.execute({ kind: "checkin", runId, seq: 8, ticketId: "S1:A-1#g1", userId: "bob" });
  check("checked-in transfer -> already_checked_in", t.ok === false && t.reason === "already_checked_in", `reason=${t.reason}`);
  check("checked-in refund -> already_checked_in", r.ok === false && r.reason === "already_checked_in", `reason=${r.reason}`);
  check("repeat checkin -> already_checked_in", c.ok === false && c.reason === "already_checked_in", `reason=${c.reason}`);
  check("history retains alice->bob", (() => {
    const h = ledger.ownershipHistory("S1:A-1#g1").find((e) => e.action === "transfer");
    return h?.fromUserId === "alice" && h.toUserId === "bob";
  })(), "ownership immutable");
  ledger.close();
}

console.log(`\n=== Result: ${failures === 0 ? "ALL SCENARIOS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);

