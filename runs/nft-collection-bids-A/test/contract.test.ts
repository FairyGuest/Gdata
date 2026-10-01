import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allocateRoyalty, computeRoyaltyAmount, splitPayment } from "../src/contract/arithmetic.js";
import { parseAcceptBid, parseCancelBid, parseCreateBid } from "../src/contract/parser.js";
import { AppError } from "../src/contract/errors.js";

/** Independent reference implementation using BigInt integer division. */
function referenceRoyalty(bid: number, bps: number): number {
  return Number((BigInt(bid) * BigInt(bps)) / 10000n);
}

function expectError(fn: () => unknown): AppError {
  assert.throws(fn, (error: unknown) => error instanceof AppError);
  let caught!: AppError;
  try {
    fn();
  } catch (error) {
    caught = error as AppError;
  }
  return caught;
}

describe("royalty arithmetic", () => {
  it("floor(1003 * 250 / 10000) = 25 and seller receives 978", () => {
    assert.equal(computeRoyaltyAmount(1003, 250), 25);
    assert.equal(referenceRoyalty(1003, 250), 25);
    assert.equal(1003 - computeRoyaltyAmount(1003, 250), 978);
    const split = splitPayment(1003, 250, [
      { userId: "u_dave", weight: 70 },
      { userId: "u_carol", weight: 30 },
    ]);
    assert.equal(split.sellerAmount, 978);
    assert.equal(split.royaltyAmount, 25);
    assert.equal(split.recipientPayments.reduce((sum, part) => sum + part.amount, 0), 25);
  });

  it("matches the independent BigInt reference across a fixed non-divisible table", () => {
    const cases: ReadonlyArray<readonly [number, number]> = [
      [1, 1],
      [99, 9999],
      [1003, 250],
      [10000, 333],
      [7777, 1001],
      [42, 2500],
    ];
    for (const [bid, bps] of cases) {
      assert.equal(computeRoyaltyAmount(bid, bps), referenceRoyalty(bid, bps), `bid=${bid} bps=${bps}`);
    }
  });

  it("largest-remainder allocation always distributes the exact royalty total", () => {
    for (const royalty of [1, 2, 5, 25, 100, 999, 1003]) {
      const payments = allocateRoyalty(royalty, [
        { userId: "a", weight: 1 },
        { userId: "b", weight: 1 },
        { userId: "c", weight: 1 },
      ]);
      assert.equal(
        payments.reduce((sum, payment) => sum + payment.amount, 0),
        royalty,
        `royalty=${royalty}`,
      );
    }
    const payments = allocateRoyalty(25, [
      { userId: "u_dave", weight: 70 },
      { userId: "u_carol", weight: 30 },
    ]);
    assert.deepEqual(payments, [
      { userId: "u_dave", amount: 18 },
      { userId: "u_carol", amount: 7 },
    ]);
  });

  it("zero bps means zero royalty and the seller receives the full bid", () => {
    const split = splitPayment(500, 0, [{ userId: "u_dave", weight: 100 }]);
    assert.equal(split.royaltyAmount, 0);
    assert.equal(split.sellerAmount, 500);
    assert.deepEqual(split.recipientPayments, [{ userId: "u_dave", amount: 0 }]);
  });

  it("rejects invalid bps ranges as compute failures", () => {
    assert.throws(() => computeRoyaltyAmount(100, 10001), (error: unknown) => {
      return error instanceof AppError && error.reason === "invariant_violation" && error.statusCode === 500;
    });
  });
});

describe("contract parsing", () => {
  it("accepts well-formed create/cancel/accept payloads", () => {
    assert.deepEqual(parseCreateBid({ bidderId: "u_alice", collectionId: "col_punks", amount: 1003 }), {
      kind: "create_bid",
      bidderId: "u_alice",
      collectionId: "col_punks",
      amount: 1003,
    });
    assert.deepEqual(parseCancelBid("bid_1", { requesterId: "u_alice" }), {
      kind: "cancel_bid",
      bidId: "bid_1",
      requesterId: "u_alice",
    });
    assert.deepEqual(parseAcceptBid("bid_1", { sellerId: "u_bob", tokenId: "t_punk_1" }), {
      kind: "accept_bid",
      bidId: "bid_1",
      sellerId: "u_bob",
      tokenId: "t_punk_1",
    });
  });

  it("classifies non-positive / non-integer prices as 422 price_not_positive_integer", () => {
    for (const amount of [0, -1, 1.5, "1.5", true, {}, []]) {
      const error = expectError(() => parseCreateBid({ bidderId: "u_alice", collectionId: "col_punks", amount }));
      assert.equal(error.statusCode, 422, String(amount));
      assert.equal(error.reason, "price_not_positive_integer", String(amount));
    }
  });

  it("classifies missing fields and malformed bodies distinctly as 422", () => {
    const missing = expectError(() => parseCreateBid({ bidderId: "u_alice", amount: 10 }));
    assert.equal(missing.statusCode, 422);
    assert.equal(missing.reason, "missing_field");
    const malformed = expectError(() => parseCreateBid("{not json"));
    assert.equal(malformed.statusCode, 422);
    assert.equal(malformed.reason, "malformed_body");
  });
});
