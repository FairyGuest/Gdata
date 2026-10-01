import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, call, createBid } from "./helpers.js";

test("non-divisible royalty: bid=1003 bps=250 splits 25 / 978", async () => {
  const built = makeApp();
  // Independent arithmetic, computed outside the system under test.
  const expectedRoyalty = Math.floor((1003 * 250) / 10000);
  const expectedSeller = 1003 - expectedRoyalty;
  assert.equal(expectedRoyalty, 25);
  assert.equal(expectedSeller, 978);

  const sellerBefore = (await call(built, "GET", "/accounts/seller-1")).body.account;
  const royaltyBefore = (await call(built, "GET", "/accounts/royalty-alpha")).body.account;
  const buyerBefore = (await call(built, "GET", "/accounts/buyer-1")).body.account;

  const created = await createBid(built, "buyer-1", "col-alpha", 1003);
  const bidId = created.body.bid.id as string;
  const accepted = await call(built, "POST", "/bids/" + bidId + "/accept", {
    sellerId: "seller-1",
    tokenId: "alpha-1",
  });
  assert.equal(accepted.status, 200);
  const fill = accepted.body.fill;
  assert.equal(fill.price, 1003);
  assert.equal(fill.royalty, expectedRoyalty);
  assert.equal(fill.sellerProceeds, expectedSeller);
  assert.equal(fill.royalty + fill.sellerProceeds, fill.price);
  assert.equal(fill.newOwnerId, "buyer-1");

  const sellerAfter = (await call(built, "GET", "/accounts/seller-1")).body.account;
  const royaltyAfter = (await call(built, "GET", "/accounts/royalty-alpha")).body.account;
  const buyerAfter = (await call(built, "GET", "/accounts/buyer-1")).body.account;
  assert.equal(sellerAfter.available, sellerBefore.available + expectedSeller);
  assert.equal(royaltyAfter.available, royaltyBefore.available + expectedRoyalty);
  // Buyer pays exactly the bid: frozen released, available untouched by the fill.
  assert.equal(buyerAfter.available, buyerBefore.available - 1003);
  assert.equal(buyerAfter.frozen, 0);
  // Ledger conservation: buyer loss equals seller + royalty gains.
  const buyerDelta =
    buyerAfter.available + buyerAfter.frozen - buyerBefore.available - buyerBefore.frozen;
  const gain =
    sellerAfter.available - sellerBefore.available +
    (royaltyAfter.available - royaltyBefore.available);
  assert.equal(buyerDelta + gain, 0);
});

test("royalty snapshot: later collection config change does not affect existing bids", async () => {
  const built = makeApp();
  const created = await createBid(built, "buyer-1", "col-alpha", 2000);
  const bid = created.body.bid;
  assert.equal(bid.royaltyBps, 250);

  const changed = await call(built, "POST", "/admin/collections/col-alpha/royalty", {
    bps: 900,
    recipient: "royalty-alpha",
  });
  assert.equal(changed.status, 200);

  const accepted = await call(built, "POST", "/bids/" + bid.id + "/accept", {
    sellerId: "seller-1",
    tokenId: "alpha-1",
  });
  assert.equal(accepted.status, 200);
  // Split must follow the 250bps snapshot taken at bid creation.
  assert.equal(accepted.body.fill.royaltyBps, 250);
  assert.equal(accepted.body.fill.royalty, 50);
  assert.equal(accepted.body.fill.sellerProceeds, 1950);

  // A bid created after the change picks up the new config.
  const newer = await createBid(built, "buyer-1", "col-alpha", 2000);
  assert.equal(newer.body.bid.royaltyBps, 900);
});

test("fill response fields come from one commit snapshot", async () => {
  const built = makeApp();
  const created = await createBid(built, "buyer-1", "col-beta", 777);
  const bidId = created.body.bid.id as string;
  const accepted = await call(built, "POST", "/bids/" + bidId + "/accept", {
    sellerId: "seller-2",
    tokenId: "beta-2",
  });
  assert.equal(accepted.status, 200);
  const fill = accepted.body.fill;
  const bid = (await call(built, "GET", "/bids/" + bidId)).body.bid;
  assert.equal(bid.stateSeq, fill.commitSeq);
  assert.equal(bid.fillTokenId, fill.tokenId);
  assert.equal(bid.fillSellerId, fill.sellerId);
  const token = built.ledger.getToken("beta-2");
  assert.equal(token?.ownerId, fill.newOwnerId);
});