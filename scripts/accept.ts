/**
 * One-shot acceptance drill. Runs every scenario from the task spec in a
 * fixed order against a fresh in-memory service, printing each request,
 * response and verdict. Exit code 0 = all scenarios passed.
 */
import { buildApp, type BuiltApp } from "../src/server.js";

const RUN_ID = "accept-" + Date.now().toString(36);
const SEED = 20261001;

const failedScenarios: string[] = [];
let currentScenario = "";
let scenarioFailed = false;

function scenario(name: string): void {
  if (currentScenario && scenarioFailed) failedScenarios.push(currentScenario);
  currentScenario = name;
  scenarioFailed = false;
  console.log("");
  console.log("=== " + name + " ===");
}

function check(label: string, cond: boolean, detail?: unknown): void {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) scenarioFailed = true;
  const extra = detail === undefined ? "" : " | " + JSON.stringify(detail);
  console.log("  [" + mark + "] " + label + extra);
}

async function req(
  built: BuiltApp,
  method: "GET" | "POST",
  url: string,
  payload?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  console.log("  -> " + method + " " + url + (payload ? " " + JSON.stringify(payload) : ""));
  const res = await built.app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
  });
  const body = res.json() as any;
  const text = JSON.stringify(body);
  console.log(
    "  <- " + res.statusCode + " " + (text.length > 240 ? text.slice(0, 240) + "..." : text),
  );
  return { status: res.statusCode, body };
}

async function main(): Promise<void> {
  console.log("NFT collection bids - acceptance drill");
  console.log("runId=" + RUN_ID + " seed=" + SEED);

  const built = buildApp({ dbPath: ":memory:", seed: SEED, port: "0", runId: RUN_ID });

  scenario("S1 fixture health and initial ledger");
  const health = await req(built, "GET", "/health");
  check("health ok", health.status === 200 && health.body.ok === true);
  const summary = await req(built, "GET", "/fixtures/summary");
  const initialTotal = summary.body.totalBalances as number;
  check("2 collections seeded", summary.body.collections.length === 2);
  check("10 tokens seeded", summary.body.tokens.length === 10);
  check("col-alpha royalty 250bps", summary.body.collections[0].royaltyBps === 250);

  scenario("S2 create bid freezes bidder balance");
  const buyer1Before = (await req(built, "GET", "/accounts/buyer-1")).body.account;
  const created = await req(built, "POST", "/bids", {
    bidderId: "buyer-1",
    collectionId: "col-alpha",
    price: 1003,
  });
  check("create 200", created.status === 200);
  const bidId = created.body.bid.id as string;
  const buyer1After = (await req(built, "GET", "/accounts/buyer-1")).body.account;
  check("available decreased by 1003", buyer1After.available === buyer1Before.available - 1003);
  check("frozen increased by 1003", buyer1After.frozen === buyer1Before.frozen + 1003);
  check("royalty snapshot 250bps on bid", created.body.bid.royaltyBps === 250);

  scenario("S3 accept with non-divisible royalty (bid=1003, bps=250)");
  const expectedRoyalty = Math.floor((1003 * 250) / 10000);
  const expectedSeller = 1003 - expectedRoyalty;
  console.log("  independent arithmetic: royalty=" + expectedRoyalty + " seller=" + expectedSeller);
  const sellerBefore = (await req(built, "GET", "/accounts/seller-1")).body.account;
  const accepted = await req(built, "POST", "/bids/" + bidId + "/accept", {
    sellerId: "seller-1",
    tokenId: "alpha-1",
  });
  check("accept 200", accepted.status === 200);
  check("royalty == 25", accepted.body.fill.royalty === expectedRoyalty, accepted.body.fill);
  check("seller proceeds == 978", accepted.body.fill.sellerProceeds === expectedSeller);
  check("split sums to price", accepted.body.fill.royalty + accepted.body.fill.sellerProceeds === 1003);
  check("new owner is buyer-1", accepted.body.fill.newOwnerId === "buyer-1");
  const sellerAfter = (await req(built, "GET", "/accounts/seller-1")).body.account;
  const royaltyAcct = (await req(built, "GET", "/accounts/royalty-alpha")).body.account;
  check("seller credited 978", sellerAfter.available === sellerBefore.available + expectedSeller);
  check("royalty recipient credited 25", royaltyAcct.available === expectedRoyalty);
  const buyer1Filled = (await req(built, "GET", "/accounts/buyer-1")).body.account;
  check("buyer paid exactly bid (frozen deducted)", buyer1Filled.frozen === 0 && buyer1Filled.available === buyer1Before.available - 1003);
  check("ledger conserved", built.ledger.totalBalances() === initialTotal);

  scenario("S4 insufficient balance -> 409 insufficient_balance");
  const poor = await req(built, "POST", "/bids", {
    bidderId: "buyer-2",
    collectionId: "col-alpha",
    price: 10000000,
  });
  check("status 409", poor.status === 409);
  check("reason insufficient_balance", poor.body.reason === "insufficient_balance", poor.body.reason);

  scenario("S5 input errors -> 422 with distinct reasons");
  const badPrice = await req(built, "POST", "/bids", { bidderId: "buyer-1", collectionId: "col-alpha", price: -5 });
  check("negative price 422 invalid_price", badPrice.status === 422 && badPrice.body.reason === "invalid_price");
  const fracPrice = await req(built, "POST", "/bids", { bidderId: "buyer-1", collectionId: "col-alpha", price: 1.5 });
  check("fractional price 422 invalid_price", fracPrice.status === 422 && fracPrice.body.reason === "invalid_price");
  const badCol = await req(built, "POST", "/bids", { bidderId: "buyer-1", collectionId: "col-nope", price: 100 });
  check("unknown collection 422", badCol.status === 422 && badCol.body.reason === "unknown_collection");
  const probe = await req(built, "POST", "/bids", { bidderId: "buyer-1", collectionId: "col-alpha", price: 100 });
  const probeId = probe.body.bid.id as string;
  const badToken = await req(built, "POST", "/bids/" + probeId + "/accept", { sellerId: "seller-1", tokenId: "alpha-999" });
  check("unknown token 422", badToken.status === 422 && badToken.body.reason === "unknown_token");
  const wrongCol = await req(built, "POST", "/bids/" + probeId + "/accept", { sellerId: "seller-1", tokenId: "beta-1" });
  check("token not in collection 422", wrongCol.status === 422 && wrongCol.body.reason === "token_not_in_collection");
  await req(built, "POST", "/bids/" + probeId + "/cancel", { actorId: "buyer-1" });

  scenario("S6 cancel rules: non-creator 409, creator ok, re-bid ok");
  const c1 = await req(built, "POST", "/bids", { bidderId: "buyer-1", collectionId: "col-beta", price: 500 });
  const c1Id = c1.body.bid.id as string;
  const stranger = await req(built, "POST", "/bids/" + c1Id + "/cancel", { actorId: "buyer-2" });
  check("non-creator 409 not_bid_creator", stranger.status === 409 && stranger.body.reason === "not_bid_creator");
  const own = await req(built, "POST", "/bids/" + c1Id + "/cancel", { actorId: "buyer-1" });
  check("creator cancel 200", own.status === 200 && own.body.bid.status === "cancelled");
  const afterCancel = (await req(built, "GET", "/accounts/buyer-1")).body.account;
  check("freeze released", afterCancel.frozen === 0);
  const rebid = await req(built, "POST", "/bids", { bidderId: "buyer-1", collectionId: "col-beta", price: 500 });
  check("re-bid after cancel 200", rebid.status === 200);
  const dupCancel = await req(built, "POST", "/bids/" + c1Id + "/cancel", { actorId: "buyer-1" });
  check("double cancel 409 bid_already_cancelled", dupCancel.status === 409 && dupCancel.body.reason === "bid_already_cancelled");

  scenario("S7 filled bid cannot be cancelled -> 409 bid_already_filled");
  const filledCancel = await req(built, "POST", "/bids/" + bidId + "/cancel", { actorId: "buyer-1" });
  check("status 409", filledCancel.status === 409);
  check("reason bid_already_filled", filledCancel.body.reason === "bid_already_filled", filledCancel.body.reason);
  scenario("S8 royalty snapshot isolation across collection config change");
  const s8 = await req(built, "POST", "/bids", { bidderId: "buyer-1", collectionId: "col-alpha", price: 2000 });
  const s8Id = s8.body.bid.id as string;
  check("bid snapshots 250bps", s8.body.bid.royaltyBps === 250);
  const change = await req(built, "POST", "/admin/collections/col-alpha/royalty", { bps: 900, recipient: "royalty-alpha" });
  check("collection now 900bps", change.body.collection.royaltyBps === 900);
  const s8fill = await req(built, "POST", "/bids/" + s8Id + "/accept", { sellerId: "seller-2", tokenId: "alpha-2" });
  const s8expected = Math.floor((2000 * 250) / 10000);
  check("fill uses snapshot bps 250", s8fill.body.fill.royaltyBps === 250);
  check("royalty == 50 (not 180)", s8fill.body.fill.royalty === s8expected, s8fill.body.fill.royalty);
  check("seller proceeds == 1950", s8fill.body.fill.sellerProceeds === 2000 - s8expected);
  const s8new = await req(built, "POST", "/bids", { bidderId: "buyer-1", collectionId: "col-alpha", price: 2000 });
  check("new bid picks up 900bps", s8new.body.bid.royaltyBps === 900);
  await req(built, "POST", "/bids/" + s8new.body.bid.id + "/cancel", { actorId: "buyer-1" });

  scenario("S9 multiple bids on one collection coexist");
  const m1 = await req(built, "POST", "/bids", { bidderId: "buyer-1", collectionId: "col-beta", price: 700 });
  const m2 = await req(built, "POST", "/bids", { bidderId: "buyer-2", collectionId: "col-beta", price: 900 });
  check("both created", m1.status === 200 && m2.status === 200);
  const m1fill = await req(built, "POST", "/bids/" + m1.body.bid.id + "/accept", { sellerId: "seller-1", tokenId: "beta-1" });
  check("first bid filled", m1fill.status === 200);
  const m2state = await req(built, "GET", "/bids/" + m2.body.bid.id);
  check("second bid still open", m2state.body.bid.status === "open");
  const m2cancel = await req(built, "POST", "/bids/" + m2.body.bid.id + "/cancel", { actorId: "buyer-2" });
  check("second bid independently cancellable", m2cancel.status === 200);

  scenario("S10 same token accepted against two bids: one fill only");
  const d1 = await req(built, "POST", "/bids", { bidderId: "buyer-1", collectionId: "col-alpha", price: 1000 });
  const d2 = await req(built, "POST", "/bids", { bidderId: "buyer-2", collectionId: "col-alpha", price: 1500 });
  const d1fill = await req(built, "POST", "/bids/" + d1.body.bid.id + "/accept", { sellerId: "seller-1", tokenId: "alpha-3" });
  check("first accept 200", d1fill.status === 200);
  const d2fill = await req(built, "POST", "/bids/" + d2.body.bid.id + "/accept", { sellerId: "seller-1", tokenId: "alpha-3" });
  check("second accept 409 seller_not_token_owner", d2fill.status === 409 && d2fill.body.reason === "seller_not_token_owner", d2fill.body.reason);
  const tokenNow = built.ledger.getToken("alpha-3");
  check("ownership transferred exactly once (to buyer-1)", tokenNow?.ownerId === "buyer-1");
  const d2state = await req(built, "GET", "/bids/" + d2.body.bid.id);
  check("losing bid still open with freeze intact", d2state.body.bid.status === "open");
  const buyer2Now = (await req(built, "GET", "/accounts/buyer-2")).body.account;
  check("buyer-2 freeze still 1500", buyer2Now.frozen === 1500);

  scenario("S11 concurrent accept vs cancel: commit sequence arbitrates, exactly one wins");
  {
    let releaseAccept!: () => void;
    let acceptParked!: () => void;
    const gate = new Promise<void>((r) => (releaseAccept = r));
    const parked = new Promise<void>((r) => (acceptParked = r));
    const raced = buildApp(
      { dbPath: ":memory:", seed: SEED, port: "0", runId: RUN_ID + "-race" },
      {
        beforeCommit: async (op) => {
          if (op === "accept") {
            acceptParked();
            await gate;
          }
        },
      },
    );
    const raceTotal = raced.ledger.totalBalances();
    const rb = await req(raced, "POST", "/bids", { bidderId: "buyer-1", collectionId: "col-alpha", price: 1003 });
    const rbId = rb.body.bid.id as string;
    const acceptP = raced.app
      .inject({ method: "POST", url: "/bids/" + rbId + "/accept", payload: { sellerId: "seller-1", tokenId: "alpha-1" } })
      .then((r) => ({ status: r.statusCode, body: r.json() as any }));
    await parked;
    console.log("  .. accept parked before commit; cancel commits first");
    const cancelRes = await req(raced, "POST", "/bids/" + rbId + "/cancel", { actorId: "buyer-1" });
    releaseAccept();
    const acceptRes = await acceptP;
    console.log("  <- accept " + acceptRes.status + " " + JSON.stringify(acceptRes.body));
    check("cancel wins with 200", cancelRes.status === 200);
    check("accept loses with 409 race_lost", acceptRes.status === 409 && acceptRes.body.reason === "race_lost", acceptRes.body.reason);
    check("loser sees winning commit seq", typeof acceptRes.body.details?.winningCommitSeq === "number");
    const rbid = await req(raced, "GET", "/bids/" + rbId);
    check("final state cancelled (exactly one effect)", rbid.body.bid.status === "cancelled");
    const raceBuyer = (await req(raced, "GET", "/accounts/buyer-1")).body.account;
    check("freeze released, no fill deduction", raceBuyer.frozen === 0);
    check("ownership untouched", raced.ledger.getToken("alpha-1")?.ownerId === "seller-1");
    check("ledger conserved across race", raced.ledger.totalBalances() === raceTotal);
    raced.ledger.close();
  }

  scenario("S12 final conservation and diagnostics");
  check("main ledger conserved end-to-end", built.ledger.totalBalances() === initialTotal, {
    initialTotal,
    finalTotal: built.ledger.totalBalances(),
  });
  const diag = await req(built, "GET", "/diag/events");
  const events = diag.body.events as any[];
  check("diag events recorded", events.length > 0, events.length);
  const fills = events.filter((e) => e.eventType === "bid_filled");
  check("every fill has split detail", fills.every((e) => e.detail && typeof e.detail.royalty === "number" && typeof e.detail.sellerProceeds === "number" && e.detail.royalty + e.detail.sellerProceeds === e.detail.price));
  check("every fill carries run id and commit seq", fills.every((e) => e.runId === RUN_ID && typeof e.commitSeq === "number"));
  const rejects = events.filter((e) => e.eventType.endsWith("_rejected"));
  check("rejections carry distinct reasons", rejects.every((e) => typeof e.reason === "string" && e.reason.length > 0), rejects.map((e) => e.reason));
  console.log("  diag sample: " + JSON.stringify(events.filter((e) => e.bidId === bidId).map((e) => ({ seq: e.commitSeq, type: e.eventType, reason: e.reason }))));

  if (currentScenario && scenarioFailed) failedScenarios.push(currentScenario);
  built.ledger.close();

  console.log("");
  if (failedScenarios.length === 0) {
    console.log("ACCEPT RESULT: all scenarios passed");
    process.exit(0);
  } else {
    console.log("ACCEPT RESULT: FAILED scenarios: " + failedScenarios.join("; "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("ACCEPT RESULT: crashed", err);
  process.exit(1);
});
