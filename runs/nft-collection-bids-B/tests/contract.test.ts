import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, call, createBid } from "./helpers.js";

test("non-positive or non-integer price is 422 invalid_price", async () => {
  const built = makeApp();
  for (const price of [0, -5, 1.5, Number.NaN]) {
    const res = await createBid(built, "buyer-1", "col-alpha", price);
    assert.equal(res.status, 422, "price=" + price);
    assert.equal(res.body.reason, "invalid_price");
  }
});

test("unknown collection is 422 unknown_collection", async () => {
  const built = makeApp();
  const res = await createBid(built, "buyer-1", "col-nope", 100);
  assert.equal(res.status, 422);
  assert.equal(res.body.reason, "unknown_collection");
});

test("unknown token is 422 unknown_token", async () => {
  const built = makeApp();
  const created = await createBid(built, "buyer-1", "col-alpha", 100);
  const res = await call(built, "POST", "/bids/" + created.body.bid.id + "/accept", {
    sellerId: "seller-1",
    tokenId: "alpha-999",
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.reason, "unknown_token");
});

test("token from another collection is 422 token_not_in_collection", async () => {
  const built = makeApp();
  const created = await createBid(built, "buyer-1", "col-alpha", 100);
  const res = await call(built, "POST", "/bids/" + created.body.bid.id + "/accept", {
    sellerId: "seller-1",
    tokenId: "beta-1",
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.reason, "token_not_in_collection");
});

test("missing fields are 422 invalid_field", async () => {
  const built = makeApp();
  const res = await call(built, "POST", "/bids", { bidderId: "buyer-1" });
  assert.equal(res.status, 422);
  assert.equal(res.body.reason, "invalid_field");
});