import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/contract/errors.js";
import { assertDeltasConserve } from "../src/kernel/invariants.js";
import { ledgerRepo } from "../src/state/ledger-repo.js";
import { createHarness, deferred, settled, expectAppError, type TestHarness } from "./helpers.js";

describe("matching kernel", () => {
  let harness: TestHarness;

  before(async () => {
    harness = await createHarness({ lockTimeoutMs: 4000, busyTimeoutMs: 100 });
  });

  after(() => harness.dispose());

  it("freeze boundary: insufficient balance -> 409 with a distinct reason and no commit", async () => {
    const before = await harness.queries.getAccount("u_eve");
    const outcome = await settled(harness.matcher.createBid({ kind: "create_bid", bidderId: "u_eve", collectionId: "col_punks", amount: 301 }));
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") {
      const error = expectAppError(outcome.reason);
      assert.equal(error.statusCode, 409);
      assert.equal(error.reason, "insufficient_balance");
    }
    const after = await harness.queries.getAccount("u_eve");
    assert.deepEqual(after, before);
  });

  it("cancel releases the freeze and the same balance can fund a new bid", async () => {
    const created = await harness.matcher.createBid({ kind: "create_bid", bidderId: "u_eve", collectionId: "col_punks", amount: 300 });
    assert.equal(created.bid.status, "active");
    assert.equal(created.bidderBalances.available, 0);
    assert.equal(created.bidderBalances.frozen, 300);

    const cancelled = await harness.matcher.cancelBid({ kind: "cancel_bid", bidId: created.bid.bidId, requesterId: "u_eve" });
    assert.equal(cancelled.unfrozenAmount, 300);
    assert.equal(cancelled.bidderBalances.available, 300);
    assert.equal(cancelled.bidderBalances.frozen, 0);

    const again = await harness.matcher.createBid({ kind: "create_bid", bidderId: "u_eve", collectionId: "col_apes", amount: 250 });
    assert.equal(again.bid.status, "active");
    assert.equal(again.bidderBalances.available, 50);
    assert.equal(again.bidderBalances.frozen, 250);

    const notOwner = await settled(
      harness.matcher.cancelBid({ kind: "cancel_bid", bidId: again.bid.bidId, requesterId: "u_bob" }),
    );
    assert.equal(notOwner.status, "rejected");
    if (notOwner.status === "rejected") {
      assert.equal(expectAppError(notOwner.reason).reason, "not_bid_owner");
    }
  });

  it("non-divisible royalty: bid 1003 at 250 bps -> royalty 25, seller 978, split sum equals price", async () => {
    const created = await harness.matcher.createBid({
      kind: "create_bid", bidderId: "u_alice", collectionId: "col_punks", amount: 1003,
    });
    assert.equal(created.bid.royaltyBpsSnapshot, 250);
    const totalsBefore = await harness.queries.ledgerTotals();

    const filled = await harness.matcher.acceptBid({
      kind: "accept_bid", bidId: created.bid.bidId, sellerId: "u_bob", tokenId: "t_punk_1",
    });
    assert.equal(filled.price, 1003);
    assert.equal(filled.royaltyAmount, 25);
    assert.equal(filled.sellerAmount, 978);
    assert.equal(filled.newOwnerId, "u_alice");
    assert.deepEqual(filled.splits, [
      { userId: "u_dave", amount: 18 },
      { userId: "u_carol", amount: 7 },
    ]);

    const view = await harness.queries.getBid(created.bid.bidId);
    assert.ok(view);
    assert.equal(view!.royaltyPayments.reduce((sum, payment) => sum + payment.amount, 0), 25);
    const totalsAfter = await harness.queries.ledgerTotals();
    // settlement moves the buyer's frozen funds into sellers'/recipients' available balances;
    // both buckets may change, but their combined total is conserved
    assert.equal(totalsAfter.available + totalsAfter.frozen, totalsBefore.available + totalsBefore.frozen);

    const token = await harness.queries.getToken("t_punk_1");
    assert.equal(token!.ownerId, "u_alice");
  });

  it("cancelling a filled bid is 409 bid_already_filled (distinct from other conflicts)", async () => {
    const outcome = await settled(
      harness.matcher.cancelBid({ kind: "cancel_bid", bidId: "bid_000003", requesterId: "u_alice" }),
    );
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") {
      const error = expectAppError(outcome.reason);
      assert.equal(error.statusCode, 409);
      assert.equal(error.reason, "bid_already_filled");
    }
    const view = await harness.queries.getBid("bid_000003");
    assert.equal(view!.bid.status, "filled");
  });

  it("snapshot consistency: later royalty changes do not affect existing bids", async () => {
    const existing = await harness.matcher.createBid({
      kind: "create_bid", bidderId: "u_carol", collectionId: "col_punks", amount: 1000,
    });
    const updated = await harness.matcher.updateRoyalty({
      collectionId: "col_punks", royaltyBps: 1000, recipients: [{ userId: "u_dave", weight: 100 }],
    });
    assert.equal(updated.version, 2);
    assert.equal(existing.bid.royaltyBpsSnapshot, 250);

    const filled = await harness.matcher.acceptBid({
      kind: "accept_bid", bidId: existing.bid.bidId, sellerId: "u_bob", tokenId: "t_punk_3",
    });
    assert.equal(filled.royaltyBpsSnapshot, 250);
    assert.equal(filled.royaltyAmount, 25);
    assert.equal(filled.sellerAmount, 975);

    const fresh = await harness.matcher.createBid({
      kind: "create_bid", bidderId: "u_alice", collectionId: "col_punks", amount: 1000,
    });
    assert.equal(fresh.bid.royaltyBpsSnapshot, 1000);
  });

  it("same token accepted twice: first wins, second loses with seller_does_not_own_token and ownership moves once", async () => {
    const firstBid = await harness.matcher.createBid({
      kind: "create_bid", bidderId: "u_alice", collectionId: "col_apes", amount: 700,
    });
    const competingBid = await harness.matcher.createBid({
      kind: "create_bid", bidderId: "u_carol", collectionId: "col_apes", amount: 900,
    });

    const first = await harness.matcher.acceptBid({
      kind: "accept_bid", bidId: firstBid.bid.bidId, sellerId: "u_bob", tokenId: "t_ape_1",
    });
    assert.equal(first.newOwnerId, "u_alice");

    const second = await settled(
      harness.matcher.acceptBid({
        kind: "accept_bid", bidId: competingBid.bid.bidId, sellerId: "u_bob", tokenId: "t_ape_1",
      }),
    );
    assert.equal(second.status, "rejected");
    if (second.status === "rejected") {
      const error = expectAppError(second.reason);
      assert.equal(error.statusCode, 409);
      assert.equal(error.reason, "seller_does_not_own_token");
    }
    const token = await harness.queries.getToken("t_ape_1");
    assert.equal(token!.ownerId, "u_alice");
    const losingBid = await harness.queries.getBid(competingBid.bid.bidId);
    assert.equal(losingBid!.bid.status, "active");
    assert.equal(losingBid!.bid.filledCommitSeq, null);
  });

  it("concurrent accept vs cancel: commit order decides, exactly one takes effect, ledger conserves", async () => {
    const bid = await harness.matcher.createBid({
      kind: "create_bid", bidderId: "u_alice", collectionId: "col_apes", amount: 555,
    });
    const totalsBefore = await harness.queries.ledgerTotals();

    const acceptEntered = deferred<void>();
    const releaseAccept = deferred<void>();
    const acceptPromise = harness.matcher.acceptBid(
      { kind: "accept_bid", bidId: bid.bid.bidId, sellerId: "u_bob", tokenId: "t_ape_2" },
      { hooks: { afterBegin: () => { acceptEntered.resolve(); return releaseAccept.promise; } } },
    );
    await acceptEntered.promise;
    await new Promise((resolve) => setTimeout(resolve, 80));

    const cancelPromise = harness.matcher.cancelBid({
      kind: "cancel_bid", bidId: bid.bid.bidId, requesterId: "u_alice",
    });
    await new Promise((resolve) => setTimeout(resolve, 80));

    releaseAccept.resolve();
    const [acceptOutcome, cancelOutcome] = await Promise.all([settled(acceptPromise), settled(cancelPromise)]);

    assert.equal(acceptOutcome.status, "fulfilled");
    assert.equal(cancelOutcome.status, "rejected");
    if (acceptOutcome.status === "fulfilled" && cancelOutcome.status === "rejected") {
      assert.equal(acceptOutcome.value.outcome, "filled");
      assert.equal(acceptOutcome.value.newOwnerId, "u_alice");
      const error = expectAppError(cancelOutcome.reason);
      assert.equal(error.statusCode, 409);
      assert.equal(error.reason, "commit_race_lost");
      assert.equal(acceptOutcome.value.commitSeq, (await harness.queries.getBid(bid.bid.bidId))!.bid.filledCommitSeq);
    }

    const alice = await harness.queries.getAccount("u_alice");
    // the earlier 1000-amount collection bid is still active, so 1000 stays frozen
    assert.equal(alice!.frozenBalance, 1000);
    const totalsAfter = await harness.queries.ledgerTotals();
    assert.equal(totalsAfter.available + totalsAfter.frozen, totalsBefore.available + totalsBefore.frozen);
  });

  it("multiple active bids on one collection coexist independently", async () => {
    const first = await harness.matcher.createBid({
      kind: "create_bid", bidderId: "u_dave", collectionId: "col_punks", amount: 400,
    });
    const second = await harness.matcher.createBid({
      kind: "create_bid", bidderId: "u_carol", collectionId: "col_punks", amount: 400,
    });
    assert.notEqual(first.bid.bidId, second.bid.bidId);
    const bids = await harness.queries.listBids("col_punks");
    assert.ok(bids.some((bid) => bid.bidId === first.bid.bidId && bid.status === "active"));
    assert.ok(bids.some((bid) => bid.bidId === second.bid.bidId && bid.status === "active"));
  });

  it("balance movement ledger records conservation for every commit", async () => {
    const movements = await harness.engine.read((db) => ledgerRepo.listMovements(db));
    const byCommit = new Map<number, { available: number; frozen: number }>();
    for (const movement of movements) {
      const current = byCommit.get(movement.commitSeq) ?? { available: 0, frozen: 0 };
      current.available += movement.deltaAvailable;
      current.frozen += movement.deltaFrozen;
      byCommit.set(movement.commitSeq, current);
    }
    assert.ok(byCommit.size > 0);
    for (const [seq, sums] of byCommit) {
      assert.equal(sums.available + sums.frozen, 0, `commit ${seq} must conserve`);
    }
  });

  it("invariant helper rejects money-creating delta sets with 500 compute failure", () => {
    assert.throws(
      () =>
        assertDeltasConserve(
          [
            { userId: "buyer", deltaAvailable: -100, deltaFrozen: 100, kind: "freeze" },
            { userId: "mint", deltaAvailable: 10, deltaFrozen: 0, kind: "mint" },
          ],
          { op: "fabricated" },
        ),
      (error: unknown) => error instanceof AppError && error.reason === "invariant_violation" && error.statusCode === 500,
    );
  });

  it("storage lock wait exhaustion is reported as 503 lock_timeout", async () => {
    const local = await createHarness({ lockTimeoutMs: 250, busyTimeoutMs: 30 });
    try {
      const entered = deferred<void>();
      const release = deferred<void>();
      const holder = local.matcher.createBid(
        { kind: "create_bid", bidderId: "u_dave", collectionId: "col_punks", amount: 100 },
        { hooks: { afterBegin: () => { entered.resolve(); return release.promise; } } },
      );
      await entered.promise;
      const contender = await settled(
        local.matcher.createBid({ kind: "create_bid", bidderId: "u_alice", collectionId: "col_punks", amount: 100 }),
      );
      assert.equal(contender.status, "rejected");
      if (contender.status === "rejected") {
        const error = expectAppError(contender.reason);
        assert.equal(error.statusCode, 503);
        assert.equal(error.reason, "lock_timeout");
      }
      release.resolve();
      await holder;
    } finally {
      local.dispose();
    }
  });
});
