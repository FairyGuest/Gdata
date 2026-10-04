/**
 * One-shot acceptance drill: boots the real HTTP server on an ephemeral port,
 * then walks every spec scenario in a fixed order, printing request, response
 * and the judgement for each step. Exit 0 iff every step passes.
 */
import { buildApp } from "../src/server.js";

const { app } = buildApp(":memory:");
await app.listen({ port: 0, host: "127.0.0.1" });
const addr = await app.server.address();
const base = "http://127.0.0.1:" + (typeof addr === "object" && addr ? addr.port : 0);

let failures = 0;
let step = 0;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function judge(name: string, ok: boolean, detail: string) {
  step++;
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failures++;
  console.log("[" + tag + "] step " + step + " " + name + " -- " + detail);
}

async function scenario(name: string, req: string, res: { status: number; json: unknown }, ok: boolean, why: string) {
  console.log("  scenario: " + name);
  console.log("  request : " + req);
  console.log("  response: " + res.status + " " + JSON.stringify(res.json));
  judge(name, ok, why);
}

// --- helpers ---------------------------------------------------------------

async function state() {
  return (await call("GET", "/diag/state")).json as unknown as {
    tick: number;
    commitSeq: number;
    valuation: number;
    accounts: Array<{ id: string; balance: number }>;
    tokens: Array<{ id: string; owner: string }>;
    loans: Array<Record<string, unknown>>;
    conserved: { ok: boolean; detail: string };
  };
}

const balance = (s: Awaited<ReturnType<typeof state>>, id: string) =>
  s.accounts.find((a) => a.id === id)!.balance;
const owner = (s: Awaited<ReturnType<typeof state>>, id: string) =>
  s.tokens.find((t) => t.id === id)!.owner;

/** Advance the global tick by n via dummy 0%-interest borrow+repay cycles (2 ticks each). */
async function advanceTicks(n: number) {
  while (n > 0) {
    const b = await call("POST", "/borrow", { borrower: "bob", tokenId: "nft-4", amount: 100, perTickBps: 0 });
    if (b.status !== 200) throw new Error("dummy borrow failed: " + JSON.stringify(b.json));
    const loanId = (b.json as { result: { loanId: number } }).result.loanId;
    const r = await call("POST", "/repay", { loanId, amount: 100, payer: "bob" });
    if (r.status !== 200) throw new Error("dummy repay failed: " + JSON.stringify(r.json));
    n -= 2;
  }
}

// --- S1: initial fixture state ----------------------------------------------
{
  const s = await state();
  console.log("  scenario: S1 initial fixture state");
  console.log("  state   : tick=" + s.tick + " valuation=" + s.valuation + " " + s.conserved.detail);
  judge(
    "S1 fixture seeded and conserved",
    s.tick === 0 && s.valuation === 10000 && s.conserved.ok && balance(s, "lender") === 100000,
    "tick=0, valuation=10000, pool=100000, conservation holds",
  );
}

// --- S2: borrow escrows the NFT ---------------------------------------------
let borrowTick = 0;
{
  const res = await call("POST", "/borrow", { borrower: "alice", tokenId: "nft-1", amount: 4000, perTickBps: 5 });
  const s = await state();
  borrowTick = (res.json as { tick: number }).tick ?? 0;
  await scenario(
    "S2 borrow escrows NFT and disburses",
    "POST /borrow {alice, nft-1, 4000, 5bps}",
    res,
    res.status === 200 && owner(s, "nft-1") === "escrow" && balance(s, "alice") === 9000 && balance(s, "lender") === 96000,
    "nft-1 -> escrow, alice 5000->9000, pool 100000->96000, one transaction",
  );
}

// --- S3: over-borrow rejected ------------------------------------------------
{
  const res = await call("POST", "/borrow", { borrower: "alice", tokenId: "nft-2", amount: 5001, perTickBps: 5 });
  await scenario(
    "S3 over-borrow rejected",
    "POST /borrow {alice, nft-2, 5001, 5bps} (max 5000)",
    res,
    res.status === 409 && res.json.reason === "insufficient_collateral",
    "409 insufficient_collateral",
  );
}

// --- S4: interest vector, underpay 409, overpay refunded ----------------------
{
  const b = await call("POST", "/borrow", { borrower: "alice", tokenId: "nft-2", amount: 1003, perTickBps: 5 });
  const bTick = (b.json as { tick: number }).tick;
  // Advance so the repay lands exactly 7 ticks after the borrow.
  const now = (await state()).tick;
  await advanceTicks(bTick + 6 - now);

  // Independent arithmetic: interest = floor(1003*5*7/1000) = 35, debt = 1038.
  const expectedInterest = Number((1003n * 5n * 7n) / 1000n);
  const expectedDebt = 1003 + expectedInterest;

  const quote = await call("GET", "/diag/loan/" + (b.json as { result: { loanId: number } }).result.loanId);
  const quotedDebt = (quote.json as { debt: number }).debt;
  judge(
    "S4a interest vector floor(35.105)=35",
    expectedInterest === 35 && quotedDebt === expectedDebt && expectedDebt === 1038,
    "independent=" + expectedDebt + " quoted=" + quotedDebt,
  );

  const loanId = (b.json as { result: { loanId: number } }).result.loanId;
  const under = await call("POST", "/repay", { loanId, amount: 1037, payer: "alice" });
  await scenario(
    "S4b underpayment rejected",
    "POST /repay {loan " + loanId + ", 1037} (debt 1038)",
    under,
    under.status === 409 && under.json.reason === "insufficient_repayment",
    "409 insufficient_repayment",
  );

  const aliceBefore = balance(await state(), "alice");
  const over = await call("POST", "/repay", { loanId, amount: 1100, payer: "alice" });
  const s = await state();
  await scenario(
    "S4c overpayment refunded, NFT redeemed",
    "POST /repay {loan " + loanId + ", 1100}",
    over,
    over.status === 200 &&
      (over.json as { result: { refund: number } }).result.refund === 62 &&
      balance(s, "alice") === aliceBefore - 1038 &&
      owner(s, "nft-2") === "alice",
    "refund=62, alice paid exactly 1038, nft-2 redeemed",
  );

  const again = await call("POST", "/repay", { loanId, amount: 2000, payer: "alice" });
  await scenario(
    "S4d settled loan cannot be repaid again",
    "POST /repay {loan " + loanId + ", 2000}",
    again,
    again.status === 409 && again.json.reason === "already_settled",
    "409 already_settled",
  );
}

// --- S5: liquidation line, concurrent double liquidation ----------------------
{
  const b = await call("POST", "/borrow", { borrower: "alice", tokenId: "nft-3", amount: 3000, perTickBps: 0 });
  const loanId = (b.json as { result: { loanId: number } }).result.loanId;

  const early = await call("POST", "/liquidate", { loanId, caller: "carol" });
  await scenario(
    "S5a liquidation above the line rejected",
    "POST /liquidate {loan " + loanId + "} while valuation covers debt",
    early,
    early.status === 409 && early.json.reason === "not_underwater",
    "409 not_underwater",
  );

  // Advance ticks until the ladder puts the loan underwater (valuation*10000 < debt*11000).
  for (;;) {
    const q = (await call("GET", "/diag/loan/" + loanId)).json as { valuation: number; debt: number };
    if (BigInt(q.valuation) * 10000n < BigInt(q.debt) * 11000n) break;
    await advanceTicks(2);
  }
  const pre = await state();
  console.log("  state   : underwater at tick=" + pre.tick + " valuation=" + pre.valuation);

  // Concurrent double liquidation: decided by commit sequence, exactly one wins.
  const [r1, r2] = await Promise.all([
    call("POST", "/liquidate", { loanId, caller: "carol" }),
    call("POST", "/liquidate", { loanId, caller: "bob" }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  const loser = r1.status === 409 ? r1 : r2;
  const s = await state();
  console.log("  scenario: S5b concurrent double liquidation");
  console.log("  response: " + r1.status + " / " + r2.status + " (loser reason=" + (loser.json.reason ?? "?") + ")");
  judge(
    "S5b exactly one liquidation commits",
    statuses[0] === 200 && statuses[1] === 409 && loser.json.reason === "already_settled" && owner(s, "nft-3") === "lender",
    "one 200 one 409 already_settled, nft-3 -> lender exactly once",
  );
  judge(
    "S5c ledger conserved after liquidation",
    s.conserved.ok && balance(s, "lender") + balance(s, "alice") + balance(s, "bob") + balance(s, "carol") === 109000,
    s.conserved.detail,
  );
}

// --- S6: input error classification -------------------------------------------
{
  const res = await call("POST", "/borrow", { borrower: "alice", tokenId: "nft-2", amount: 100, perTickBps: 20000 });
  await scenario(
    "S6 invalid bps classified as input error",
    "POST /borrow {..., perTickBps: 20000}",
    res,
    res.status === 422 && res.json.reason === "invalid_bps",
    "422 invalid_bps",
  );
}

// --- S7: final conservation ----------------------------------------------------
{
  const s = await state();
  judge(
    "S7 final ledger conservation",
    s.conserved.ok,
    "tick=" + s.tick + " commitSeq=" + s.commitSeq + " " + s.conserved.detail,
  );
}

await app.close();
console.log(failures === 0 ? "\nACCEPT OK: all " + step + " checks passed" : "\nACCEPT FAILED: " + failures + " check(s) failed");
process.exit(failures === 0 ? 0 : 1);
