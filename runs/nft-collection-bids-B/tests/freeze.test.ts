import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, call, createBid } from "./helpers.js";

test("create bid freezes exactly the bid price", async () => {
  const built = makeApp();
  const before = (await call(built, "GET", "/accounts/buyer-1")).body.account;
  const res = await createBid(built, "buyer-1", "col-alpha", 1003);
  assert.equal(res.status, 200);
  const after = (await call(built, "GET", "/accounts/buyer-1")).body.account;
  assert.equal(after.available, before.available - 1003);
  assert.equal(after.frozen, before.frozen + 1003);
  assert.equal(res.body.bid.status, "open");
  assert.equal(res.body.bid.royaltyBps, 250);
});

test("insufficient balance rejects with 409 insufficient_balance", async () => {
  const built = makeApp();
  const res = await createBid(built, "buyer-2", "col-alpha", 10_000_000);
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, "insufficient_balance");
  const acct = (await call(built, "GET", "/accounts/buyer-2")).body.account;
  assert.equal(acct.frozen, 0);
});

test("cancel releases the freeze and the budget can be re-bid", async () => {
  const built = makeApp();
  const created = await createBid(built, "buyer-1", "col-alpha", 5000);
  const bidId = created.body.bid.id as string;
  const cancelled = await call(built, "POST", "/bids/" + bidId + "/cancel", {
    actorId: "buyer-1",
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.bid.status, "cancelled");
  const acct = (await call(built, "GET", "/accounts/buyer-1")).body.account;
  assert.equal(acct.frozen, 0);
  const rebid = await createBid(built, "buyer-1", "col-alpha", 5000);
  assert.equal(rebid.status, 200);
});

test("cancel by non-creator rejected with 409 not_bid_creator", async () => {
  const built = makeApp();
  const created = await createBid(built, "buyer-1", "col-alpha", 100);
  const res = await call(built, "POST", "/bids/" + created.body.bid.id + "/cancel", {
    actorId: "buyer-2",
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, "not_bid_creator");
  const bid = (await call(built, "GET", "/bids/" + created.body.bid.id)).body.bid;
  assert.equal(bid.status, "open");
});

test("double cancel rejected with 409 bid_already_cancelled", async () => {
  const built = makeApp();
  const created = await createBid(built, "buyer-1", "col-alpha", 100);
  const bidId = created.body.bid.id as string;
  await call(built, "POST", "/bids/" + bidId + "/cancel", { actorId: "buyer-1" });
  const res = await call(built, "POST", "/bids/" + bidId + "/cancel", { actorId: "buyer-1" });
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, "bid_already_cancelled");
});

test("filled bid cannot be cancelled: 409 bid_already_filled", async () => {
  const built = makeApp();
  const created = await createBid(built, "buyer-1", "col-alpha", 1003);
  const bidId = created.body.bid.id as string;
  const accepted = await call(built, "POST", "/bids/" + bidId + "/accept", {
    sellerId: "seller-1",
    tokenId: "alpha-1",
  });
  assert.equal(accepted.status, 200);
  const res = await call(built, "POST", "/bids/" + bidId + "/cancel", { actorId: "buyer-1" });
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, "bid_already_filled");
});