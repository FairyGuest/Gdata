import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, call, createBid } from "./helpers.js";

function gate() {
  let release!: () => void;
  let entered!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  const ready = new Promise<void>((r) => (entered = r));
  return { wait, ready, release, entered };
}

test("race: cancel commits first, accept loses with 409 race_lost and ledger stays conserved", async () => {
  const acceptGate = gate();
  const built = makeApp({
    beforeCommit: async (op) => {
      if (op === "accept") {
        acceptGate.entered();
        await acceptGate.wait;
      }
    },
  }, "race-cancel-first");
  const initialTotal = built.ledger.totalBalances();

  const created = await createBid(built, "buyer-1", "col-alpha", 1003);
  const bidId = created.body.bid.id as string;

  // Accept validates against the open bid, then parks right before its commit.
  const acceptP = call(built, "POST", "/bids/" + bidId + "/accept", {
    sellerId: "seller-1",
    tokenId: "alpha-1",
  });
  await acceptGate.ready;

  // Cancel commits first and wins the commit-sequence race.
  const cancel = await call(built, "POST", "/bids/" + bidId + "/cancel", { actorId: "buyer-1" });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.bid.status, "cancelled");

  acceptGate.release();
  const accept = await acceptP;
  assert.equal(accept.status, 409);
  assert.equal(accept.body.reason, "race_lost");
  assert.equal(accept.body.details.currentStatus, "cancelled");
  assert.ok(accept.body.details.winningCommitSeq <= built.ledger.currentCommitSeq());

  // Exactly one effect: freeze released, no fill, ownership untouched.
  const buyer = (await call(built, "GET", "/accounts/buyer-1")).body.account;
  assert.equal(buyer.frozen, 0);
  assert.equal(built.ledger.getToken("alpha-1")?.ownerId, "seller-1");
  assert.equal(built.ledger.totalBalances(), initialTotal);
  const bid = (await call(built, "GET", "/bids/" + bidId)).body.bid;
  assert.equal(bid.status, "cancelled");
});

test("race: accept commits first, cancel loses and fill is fully settled", async () => {
  const cancelGate = gate();
  const built = makeApp({
    beforeCommit: async (op) => {
      if (op === "cancel") {
        cancelGate.entered();
        await cancelGate.wait;
      }
    },
  }, "race-accept-first");
  const initialTotal = built.ledger.totalBalances();

  const created = await createBid(built, "buyer-1", "col-alpha", 1003);
  const bidId = created.body.bid.id as string;

  const cancelP = call(built, "POST", "/bids/" + bidId + "/cancel", { actorId: "buyer-1" });
  await cancelGate.ready;

  const accept = await call(built, "POST", "/bids/" + bidId + "/accept", {
    sellerId: "seller-1",
    tokenId: "alpha-1",
  });
  assert.equal(accept.status, 200);
  assert.equal(accept.body.fill.royalty, 25);
  assert.equal(accept.body.fill.sellerProceeds, 978);

  cancelGate.release();
  const cancel = await cancelP;
  assert.equal(cancel.status, 409);
  assert.equal(cancel.body.reason, "race_lost");
  assert.equal(cancel.body.details.currentStatus, "filled");

  // Exactly one effect: fill settled, no unfreeze of the cancelled bid.
  const buyer = (await call(built, "GET", "/accounts/buyer-1")).body.account;
  assert.equal(buyer.frozen, 0);
  assert.equal(built.ledger.getToken("alpha-1")?.ownerId, "buyer-1");
  assert.equal(built.ledger.totalBalances(), initialTotal);
});

test("same token accepted against two bids: first 200, second 409 seller_not_token_owner", async () => {
  const built = makeApp();
  const a = await createBid(built, "buyer-1", "col-alpha", 1000);
  const b = await createBid(built, "buyer-2", "col-alpha", 1500);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const first = await call(built, "POST", "/bids/" + a.body.bid.id + "/accept", {
    sellerId: "seller-1",
    tokenId: "alpha-1",
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.fill.newOwnerId, "buyer-1");

  const second = await call(built, "POST", "/bids/" + b.body.bid.id + "/accept", {
    sellerId: "seller-1",
    tokenId: "alpha-1",
  });
  assert.equal(second.status, 409);
  assert.equal(second.body.reason, "seller_not_token_owner");
  assert.equal(second.body.details.currentOwnerId, "buyer-1");

  // Ownership moved exactly once; losing bid stays open with its freeze intact.
  assert.equal(built.ledger.getToken("alpha-1")?.ownerId, "buyer-1");
  const bidB = (await call(built, "GET", "/bids/" + b.body.bid.id)).body.bid;
  assert.equal(bidB.status, "open");
  const buyer2 = (await call(built, "GET", "/accounts/buyer-2")).body.account;
  assert.equal(buyer2.frozen, 1500);
});

test("multiple bids on one collection coexist independently", async () => {
  const built = makeApp();
  const a = await createBid(built, "buyer-1", "col-beta", 700);
  const b = await createBid(built, "buyer-2", "col-beta", 900);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const fill = await call(built, "POST", "/bids/" + a.body.bid.id + "/accept", {
    sellerId: "seller-1",
    tokenId: "beta-1",
  });
  assert.equal(fill.status, 200);

  const bidB = (await call(built, "GET", "/bids/" + b.body.bid.id)).body.bid;
  assert.equal(bidB.status, "open");
  const buyer2 = (await call(built, "GET", "/accounts/buyer-2")).body.account;
  assert.equal(buyer2.frozen, 900);

  const cancel = await call(built, "POST", "/bids/" + b.body.bid.id + "/cancel", {
    actorId: "buyer-2",
  });
  assert.equal(cancel.status, 200);
});