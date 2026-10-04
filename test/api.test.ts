import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../src/app.js";

describe("HTTP API", () => {
  let built: BuiltApp;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "nft-bids-api-"));
    built = await buildApp({ dbPath: join(dir, "api.db"), logFilePath: null, lockTimeoutMs: 4000, sqliteBusyTimeoutMs: 200 });
  });

  after(async () => {
    await built.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a bid with 201 and freezes the amount", async () => {
    const response = await built.app.inject({
      method: "POST",
      url: "/v1/bids",
      payload: { bidderId: "u_alice", collectionId: "col_punks", amount: 1003 },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json() as {
      commitSeq: number;
      bid: { bidId: string; status: string; royaltyBpsSnapshot: number };
      frozenAmount: number;
      bidderBalances: { available: number; frozen: number };
      runId: string;
    };
    assert.equal(body.bid.status, "active");
    assert.equal(body.frozenAmount, 1003);
    assert.equal(body.bidderBalances.frozen, 1003);
    assert.ok(body.runId);
  });

  it("422s on bad price, unknown collection and cross-collection token with distinct reasons", async () => {
    const badPrice = await built.app.inject({
      method: "POST", url: "/v1/bids", payload: { bidderId: "u_alice", collectionId: "col_punks", amount: 0 },
    });
    assert.equal(badPrice.statusCode, 422);
    assert.equal((badPrice.json() as { error: { reason: string } }).error.reason, "price_not_positive_integer");

    const unknownCollection = await built.app.inject({
      method: "POST", url: "/v1/bids", payload: { bidderId: "u_alice", collectionId: "col_missing", amount: 10 },
    });
    assert.equal(unknownCollection.statusCode, 422);
    assert.equal((unknownCollection.json() as { error: { reason: string } }).error.reason, "unknown_collection");

    const created = await built.app.inject({
      method: "POST", url: "/v1/bids", payload: { bidderId: "u_alice", collectionId: "col_punks", amount: 200 },
    });
    const bidId = (created.json() as { bid: { bidId: string } }).bid.bidId;
    const cross = await built.app.inject({
      method: "POST", url: `/v1/bids/${bidId}/accept`, payload: { sellerId: "u_bob", tokenId: "t_ape_1" },
    });
    assert.equal(cross.statusCode, 422);
    assert.equal((cross.json() as { error: { reason: string } }).error.reason, "token_not_in_collection");
  });

  it("409s insufficient balance with a distinguishable reason", async () => {
    const response = await built.app.inject({
      method: "POST", url: "/v1/bids", payload: { bidderId: "u_eve", collectionId: "col_punks", amount: 301 },
    });
    assert.equal(response.statusCode, 409);
    assert.equal((response.json() as { error: { reason: string } }).error.reason, "insufficient_balance");
  });

  it("accepts seller-selected token and reports snapshot-consistent royalty split", async () => {
    const response = await built.app.inject({
      method: "POST", url: "/v1/bids/bid_000001/accept", payload: { sellerId: "u_bob", tokenId: "t_punk_1" },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      newOwnerId: string; price: number; sellerAmount: number; royaltyAmount: number;
      splits: Array<{ userId: string; amount: number }>; commitSeq: number;
    };
    assert.equal(body.newOwnerId, "u_alice");
    assert.equal(body.price, 1003);
    assert.equal(body.sellerAmount, 978);
    assert.equal(body.royaltyAmount, 25);
    assert.equal(body.splits.reduce((sum, split) => sum + split.amount, 0), 25);
  });

  it("second accept of the same token is 409 seller_does_not_own_token and ownership moved once", async () => {
    const created = await built.app.inject({
      method: "POST", url: "/v1/bids", payload: { bidderId: "u_carol", collectionId: "col_punks", amount: 800 },
    });
    const bidId = (created.json() as { bid: { bidId: string } }).bid.bidId;
    const response = await built.app.inject({
      method: "POST", url: `/v1/bids/${bidId}/accept`, payload: { sellerId: "u_bob", tokenId: "t_punk_1" },
    });
    assert.equal(response.statusCode, 409);
    assert.equal((response.json() as { error: { reason: string } }).error.reason, "seller_does_not_own_token");

    const token = await built.app.inject({ url: "/v1/tokens/t_punk_1" });
    assert.equal((token.json() as { token: { ownerId: string } }).token.ownerId, "u_alice");
  });

  it("filled bid cannot be cancelled, but owner can cancel an active bid", async () => {
    const filledCancel = await built.app.inject({
      method: "POST", url: "/v1/bids/bid_000001/cancel", payload: { requesterId: "u_alice" },
    });
    assert.equal(filledCancel.statusCode, 409);
    assert.equal((filledCancel.json() as { error: { reason: string } }).error.reason, "bid_already_filled");

    const created = await built.app.inject({
      method: "POST", url: "/v1/bids", payload: { bidderId: "u_eve", collectionId: "col_apes", amount: 100 },
    });
    const bidId = (created.json() as { bid: { bidId: string } }).bid.bidId;
    const other = await built.app.inject({
      method: "POST", url: `/v1/bids/${bidId}/cancel`, payload: { requesterId: "u_bob" },
    });
    assert.equal(other.statusCode, 409);
    assert.equal((other.json() as { error: { reason: string } }).error.reason, "not_bid_owner");

    const own = await built.app.inject({
      method: "POST", url: `/v1/bids/${bidId}/cancel`, payload: { requesterId: "u_eve" },
    });
    assert.equal(own.statusCode, 200);
    assert.equal((own.json() as { unfrozenAmount: number }).unfrozenAmount, 100);
  });

  it("exposes diagnostic events with run ids, transitions and split details", async () => {
    const events = await built.app.inject({ url: "/diag/events?bidId=bid_000001" });
    assert.equal(events.statusCode, 200);
    const body = events.json() as { events: Array<{ runId: string; op: string; royaltyAmount: number | null; splits: unknown[] }> };
    assert.ok(body.events.length >= 2);
    assert.ok(body.events.every((event) => event.runId.startsWith("run-")));
    const acceptEvent = body.events.find((event) => event.op === "accept_bid");
    assert.ok(acceptEvent);
    assert.equal(acceptEvent!.royaltyAmount, 25);

    const commits = await built.app.inject({ url: "/diag/commits" });
    assert.equal(commits.statusCode, 200);
    const commitBody = commits.json() as { commits: Array<{ seq: number; op: string }> };
    assert.ok(commitBody.commits.some((commit) => commit.op === "accept_bid"));
    const sequences = commitBody.commits.map((commit) => commit.seq);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  });
});
