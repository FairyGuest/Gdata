import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { buildApp, type BuiltApp } from "../src/app.js";
import { AppError } from "../src/contract/errors.js";
import { ledgerRepo } from "../src/state/ledger-repo.js";

interface ApiResponse {
  status: number;
  body: unknown;
}

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[93m";
const DIM = "\x1b[90m";
const RESET = "\x1b[0m";

const failures: string[] = [];
let passedSteps = 0;

function heading(text: string): void {
  console.log(`\n${CYAN}=== ${text} ===${RESET}`);
}

function requestLine(method: string, url: string, payload?: unknown): void {
  console.log(`${DIM}${"-".repeat(72)}${RESET}`);
  console.log(`${YELLOW}REQUEST ${method} ${url}${RESET}`);
  if (payload !== undefined) console.log(`${DIM}${stableJson(payload)}${RESET}`);
}

function responseLine(response: ApiResponse): void {
  const color = response.status < 400 ? GREEN : response.status < 500 ? YELLOW : RED;
  console.log(`${color}RESPONSE ${response.status}${RESET} ${stableJson(response.body)}`);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => (typeof nested === "bigint" ? Number(nested) : nested));
}

function verdict(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passedSteps += 1;
    console.log(`${GREEN}[PASS]${RESET} ${name} ${DIM}${detail}${RESET}`);
  } else {
    failures.push(name);
    console.log(`${RED}[FAIL]${RESET} ${name} ${RED}${detail}${RESET}`);
  }
}

async function api(
  built: BuiltApp,
  method: "GET" | "POST",
  url: string,
  payload?: unknown,
): Promise<ApiResponse> {
  requestLine(method, url, payload);
  const input: InjectOptions = { method, url };
  if (payload !== undefined) {
    (input as { payload?: unknown }).payload = payload;
  }
  const response = await built.app.inject(input);
  let body: unknown = response.body;
  try {
    body = response.json();
  } catch {
    // keep raw body when it is not JSON
  }
  const wrapped = { status: response.statusCode, body };
  responseLine(wrapped);
  return wrapped;
}

function errorReason(response: ApiResponse): string | undefined {
  return (response.body as { error?: { reason?: string } })?.error?.reason;
}

function expectStatus(response: ApiResponse, expected: number, scenario: string): void {
  if (response.status !== expected) {
    throw new Error(`${scenario}: expected HTTP ${expected}, got ${response.status} (${stableJson(response.body)})`);
  }
}

function expectReason(response: ApiResponse, expectedReason: string, scenario: string): void {
  const reason = errorReason(response);
  if (reason !== expectedReason) {
    throw new Error(`${scenario}: expected reason "${expectedReason}", got "${reason ?? "<none>"}"`);
  }
}

function oracleRoyalty(bid: number, bps: number): number {
  return Number((BigInt(bid) * BigInt(bps)) / 10000n);
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function settled<T>(promise: Promise<T>): Promise<{ status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown }> {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason) => ({ status: "rejected" as const, reason }),
  );
}

async function main(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "nft-accept-"));
  const dbPath = join(dir, "accept.db");
  const built = await buildApp({
    dbPath,
    logFilePath: "logs/accept.jsonl",
    lockTimeoutMs: 4000,
    sqliteBusyTimeoutMs: 250,
  });
  console.log(`${CYAN}NFT collection-bids acceptance run${RESET}`);
  console.log(`${DIM}db=${dbPath} seed=${built.config.seed} diag=logs/accept.jsonl${RESET}`);

  try {
    heading("0. boot / deterministic fixtures");
    const health = await api(built, "GET", "/healthz");
    try {
      expectStatus(health, 200, "healthz");
      verdict("service boots with fixed-seed ledger", true, `seed=${(health.body as { seed: number }).seed}`);
    } catch (error) {
      verdict("service boots with fixed-seed ledger", false, (error as Error).message);
    }

    heading("1. input errors are 422 with distinct reasons");
    const badPrice = await api(built, "POST", "/v1/bids", { bidderId: "u_alice", collectionId: "col_punks", amount: 0 });
    try { expectStatus(badPrice, 422, "bad price"); expectReason(badPrice, "price_not_positive_integer", "bad price"); verdict("non-positive price rejected", true, "422 price_not_positive_integer"); }
    catch (error) { verdict("non-positive price rejected", false, (error as Error).message); }

    const unknownCollection = await api(built, "POST", "/v1/bids", { bidderId: "u_alice", collectionId: "col_missing", amount: 10 });
    try { expectStatus(unknownCollection, 422, "unknown collection"); expectReason(unknownCollection, "unknown_collection", "unknown collection"); verdict("unknown collection rejected", true, "422 unknown_collection"); }
    catch (error) { verdict("unknown collection rejected", false, (error as Error).message); }

    const setupBid = await api(built, "POST", "/v1/bids", { bidderId: "u_carol", collectionId: "col_punks", amount: 100 });
    const setupBidId = (setupBid.body as { bid: { bidId: string } }).bid.bidId;
    const unknownToken = await api(built, "POST", `/v1/bids/${setupBidId}/accept`, { sellerId: "u_bob", tokenId: "t_missing" });
    try { expectStatus(unknownToken, 422, "unknown token"); expectReason(unknownToken, "unknown_token", "unknown token"); verdict("unknown token rejected", true, "422 unknown_token"); }
    catch (error) { verdict("unknown token rejected", false, (error as Error).message); }

    const crossToken = await api(built, "POST", `/v1/bids/${setupBidId}/accept`, { sellerId: "u_bob", tokenId: "t_ape_1" });
    try { expectStatus(crossToken, 422, "cross collection"); expectReason(crossToken, "token_not_in_collection", "cross collection"); verdict("token from another collection rejected", true, "422 token_not_in_collection"); }
    catch (error) { verdict("token from another collection rejected", false, (error as Error).message); }

    heading("2. freeze boundary");
    const tooPoor = await api(built, "POST", "/v1/bids", { bidderId: "u_eve", collectionId: "col_punks", amount: 301 });
    try { expectStatus(tooPoor, 409, "insufficient"); expectReason(tooPoor, "insufficient_balance", "insufficient"); verdict("insufficient balance rejected before any freeze", true, "409 insufficient_balance"); }
    catch (error) { verdict("insufficient balance rejected before any freeze", false, (error as Error).message); }

    const eveBid = await api(built, "POST", "/v1/bids", { bidderId: "u_eve", collectionId: "col_apes", amount: 100 });
    const eveBidId = (eveBid.body as { bid: { bidId: string } }).bid.bidId;
    const eveCancel = await api(built, "POST", `/v1/bids/${eveBidId}/cancel`, { requesterId: "u_eve" });
    const eveRebid = await api(built, "POST", "/v1/bids", { bidderId: "u_eve", collectionId: "col_apes", amount: 100 });
    const eveRebidId = (eveRebid.body as { bid: { bidId: string } }).bid.bidId;
    try {
      expectStatus(eveCancel, 200, "eve cancel");
      expectStatus(eveRebid, 201, "eve rebid");
      const rebidBody = eveRebid.body as { bidderBalances: { available: number; frozen: number } };
      if (rebidBody.bidderBalances.available !== 200 || rebidBody.bidderBalances.frozen !== 100) {
        throw new Error(`unexpected balances after rebid: ${stableJson(rebidBody.bidderBalances)}`);
      }
      verdict("cancel releases freeze and balance can fund another bid", true, "available=200 frozen=100");
    } catch (error) {
      verdict("cancel releases freeze and balance can fund another bid", false, (error as Error).message);
    }

    heading("3. non-divisible royalty settlement (bid=1003, bps=250)");
    const totalsBeforeResponse = await built.app.inject({ url: "/v1/ledger/totals" });
    const beforeBody = (totalsBeforeResponse.json() as { totals: { available: number; frozen: number } }).totals;
    const bid1003 = await api(built, "POST", "/v1/bids", { bidderId: "u_alice", collectionId: "col_punks", amount: 1003 });
    const bid1003Id = (bid1003.body as { bid: { bidId: string } }).bid.bidId;
    const fill1003 = await api(built, "POST", `/v1/bids/${bid1003Id}/accept`, { sellerId: "u_bob", tokenId: "t_punk_1" });
    try {
      expectStatus(fill1003, 200, "royalty fill");
      const body = fill1003.body as { price: number; sellerAmount: number; royaltyAmount: number; newOwnerId: string; splits: Array<{ userId: string; amount: number }> };
      const expectedRoyalty = oracleRoyalty(1003, 250);
      if (body.royaltyAmount !== expectedRoyalty || expectedRoyalty !== 25) throw new Error(`royalty mismatch: got ${body.royaltyAmount}, oracle=${expectedRoyalty}`);
      if (body.sellerAmount !== 1003 - 25 || body.sellerAmount !== 978) throw new Error("seller amount must be 978");
      if (body.splits.reduce((sum, part) => sum + part.amount, 0) !== 25) throw new Error("split parts must sum to royalty 25");
      if (body.newOwnerId !== "u_alice") throw new Error("new owner must be the bidder");
      verdict("royalty floor split matches independent BigInt arithmetic", true, `oracle=${expectedRoyalty} seller=${body.sellerAmount} splits=${stableJson(body.splits)}`);
    } catch (error) {
      verdict("royalty floor split matches independent BigInt arithmetic", false, (error as Error).message);
    }

    const cancelFilled = await api(built, "POST", `/v1/bids/${bid1003Id}/cancel`, { requesterId: "u_alice" });
    try { expectStatus(cancelFilled, 409, "filled cancel"); expectReason(cancelFilled, "bid_already_filled", "filled cancel"); verdict("filled bid cannot be cancelled", true, "409 bid_already_filled"); }
    catch (error) { verdict("filled bid cannot be cancelled", false, (error as Error).message); }

    const notOwner = await api(built, "POST", `/v1/bids/${eveRebidId}/cancel`, { requesterId: "u_bob" });
    try { expectStatus(notOwner, 409, "non owner"); expectReason(notOwner, "not_bid_owner", "non owner"); verdict("only the bid creator may cancel", true, "409 not_bid_owner"); }
    catch (error) { verdict("only the bid creator may cancel", false, (error as Error).message); }

    heading("4. snapshot consistency: royalty changes do not affect existing bids");
    const snapshotBid = await api(built, "POST", "/v1/bids", { bidderId: "u_carol", collectionId: "col_punks", amount: 1000 });
    const snapshotBidId = (snapshotBid.body as { bid: { bidId: string } }).bid.bidId;
    const royaltyUpdate = await api(built, "POST", "/v1/admin/collections/col_punks/royalty", { royaltyBps: 1000, recipients: [{ userId: "u_dave", weight: 100 }] });
    const snapshotFill = await api(built, "POST", `/v1/bids/${snapshotBidId}/accept`, { sellerId: "u_bob", tokenId: "t_punk_3" });
    const freshSnapshotBid = await api(built, "POST", "/v1/bids", { bidderId: "u_alice", collectionId: "col_punks", amount: 1000 });
    try {
      expectStatus(royaltyUpdate, 200, "royalty update");
      expectStatus(snapshotFill, 200, "snapshot fill");
      const fillBody = snapshotFill.body as { royaltyBpsSnapshot: number; royaltyAmount: number; sellerAmount: number };
      const freshBody = freshSnapshotBid.body as { bid: { royaltyBpsSnapshot: number } };
      if (fillBody.royaltyBpsSnapshot !== 250 || fillBody.royaltyAmount !== 25 || fillBody.sellerAmount !== 975) {
        throw new Error(`existing bid must keep creation snapshot, got ${stableJson(fillBody)}`);
      }
      if (freshBody.bid.royaltyBpsSnapshot !== 1000) throw new Error("new bid must use current 1000 bps");
      verdict("existing bid settles on its creation snapshot; new bids see new config", true, `old=250bps/25 royalty, new snapshot=1000bps`);
    } catch (error) {
      verdict("existing bid settles on its creation snapshot; new bids see new config", false, (error as Error).message);
    }

    heading("5. same token accepted by two different bids");
    const bidA = await api(built, "POST", "/v1/bids", { bidderId: "u_alice", collectionId: "col_apes", amount: 700 });
    const bidB = await api(built, "POST", "/v1/bids", { bidderId: "u_carol", collectionId: "col_apes", amount: 900 });
    const bidAId = (bidA.body as { bid: { bidId: string } }).bid.bidId;
    const bidBId = (bidB.body as { bid: { bidId: string } }).bid.bidId;
    const firstAccept = await api(built, "POST", `/v1/bids/${bidAId}/accept`, { sellerId: "u_bob", tokenId: "t_ape_2" });
    const secondAccept = await api(built, "POST", `/v1/bids/${bidBId}/accept`, { sellerId: "u_bob", tokenId: "t_ape_2" });
    const tokenAfter = await api(built, "GET", "/v1/tokens/t_ape_2");
    try {
      expectStatus(firstAccept, 200, "first accept");
      expectStatus(secondAccept, 409, "second accept");
      expectReason(secondAccept, "seller_does_not_own_token", "second accept");
      const owner = (tokenAfter.body as { token: { ownerId: string } }).token.ownerId;
      if (owner !== "u_alice") throw new Error(`owner should be u_alice once, got ${owner}`);
      verdict("first accept 200, second 409 seller_does_not_own_token, ownership moves once", true, `owner=${owner}`);
    } catch (error) {
      verdict("first accept 200, second 409 seller_does_not_own_token, ownership moves once", false, (error as Error).message);
    }

    heading("6. concurrent accept vs cancel: serialized by commit sequence");
    const raceBid = await api(built, "POST", "/v1/bids", { bidderId: "u_alice", collectionId: "col_apes", amount: 555 });
    const raceBidId = (raceBid.body as { bid: { bidId: string } }).bid.bidId;
    const acceptEntered = deferred<void>();
    const releaseAccept = deferred<void>();
    const acceptPromise = built.matcher.acceptBid(
      { kind: "accept_bid", bidId: raceBidId, sellerId: "u_bob", tokenId: "t_ape_1" },
      { hooks: { afterBegin: () => { acceptEntered.resolve(); return releaseAccept.promise; } } },
    );
    await acceptEntered.promise;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cancelPromise = api(built, "POST", `/v1/bids/${raceBidId}/cancel`, { requesterId: "u_alice" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseAccept.resolve();
    const [acceptOutcome, cancelOutcome] = await Promise.all([settled(acceptPromise), cancelPromise]);
    const raceBidView = await api(built, "GET", `/v1/bids/${raceBidId}`);
    try {
      if (acceptOutcome.status !== "fulfilled") throw new Error("accept must win the deterministic commit order");
      if (cancelOutcome.status !== 409) throw new Error(`cancel must lose with 409, got ${cancelOutcome.status}`);
      expectReason(cancelOutcome, "commit_race_lost", "race cancel");
      const view = raceBidView.body as { bid: { status: string; filledCommitSeq: number | null } };
      if (view.bid.status !== "filled" || view.bid.filledCommitSeq !== acceptOutcome.value.commitSeq) {
        throw new Error(`bid view must match winning commit, got ${stableJson(view.bid)}`);
      }
      verdict("exactly one effect: accept committed first, cancel lost with commit_race_lost", true, `winningCommitSeq=${acceptOutcome.value.commitSeq}`);
    } catch (error) {
      verdict("exactly one effect: accept committed first, cancel lost with commit_race_lost", false, (error as Error).message);
    }

    heading("7. coexistence and ledger conservation");
    const co1 = await api(built, "POST", "/v1/bids", { bidderId: "u_dave", collectionId: "col_punks", amount: 111 });
    const co2 = await api(built, "POST", "/v1/bids", { bidderId: "u_carol", collectionId: "col_punks", amount: 222 });
    const list = await api(built, "GET", "/v1/bids?collectionId=col_punks");
    try {
      const bids = (list.body as { bids: Array<{ bidId: string; status: string }> }).bids;
      if (!bids.some((bid) => bid.bidId === (co1.body as { bid: { bidId: string } }).bid.bidId && bid.status === "active")) throw new Error("coexisting bid 1 missing");
      if (!bids.some((bid) => bid.bidId === (co2.body as { bid: { bidId: string } }).bid.bidId && bid.status === "active")) throw new Error("coexisting bid 2 missing");
      verdict("multiple bids on one collection coexist independently", true, `${bids.length} bids visible`);
    } catch (error) {
      verdict("multiple bids on one collection coexist independently", false, (error as Error).message);
    }

    const totalsResponse = await built.app.inject({ url: "/v1/ledger/totals" });
    const finalTotals = (totalsResponse.json() as { totals: { available: number; frozen: number } }).totals;
    const movementAudit = await built.engine.read((db) => ledgerRepo.listMovements(db));
    const byCommit = new Map<number, number>();
    for (const movement of movementAudit) {
      byCommit.set(movement.commitSeq, (byCommit.get(movement.commitSeq) ?? 0) + movement.deltaAvailable + movement.deltaFrozen);
    }
    try {
      if (beforeBody === null) throw new Error("initial totals unavailable");
      if (finalTotals.available + finalTotals.frozen !== beforeBody.available + beforeBody.frozen) {
        throw new Error(`ledger total changed: before ${stableJson(beforeBody)} after ${stableJson(finalTotals)}`);
      }
      for (const [seq, sum] of byCommit) {
        if (sum !== 0) throw new Error(`commit ${seq} moved net ${sum}`);
      }
      verdict("ledger conserved across every committed transaction", true, `combined=${finalTotals.available + finalTotals.frozen}, commits=${byCommit.size}`);
    } catch (error) {
      verdict("ledger conserved across every committed transaction", false, (error as Error).message);
    }

    heading("8. diagnostics carry run ids, transitions, splits and reasons");
    const events = await api(built, "GET", `/diag/events?bidId=${bid1003Id}`);
    const commits = await api(built, "GET", "/diag/commits?limit=200");
    try {
      const eventList = (events.body as { events: Array<{ runId: string; op: string; royaltyAmount: number | null; splits: Array<{ amount: number }> }> }).events;
      const acceptEvent = eventList.find((event) => event.op === "accept_bid");
      if (!acceptEvent || !acceptEvent.runId.startsWith("run-")) throw new Error("accept diagnostic event missing run id");
      if (acceptEvent.royaltyAmount !== 25) throw new Error("diagnostic royalty must be 25");
      const commitList = (commits.body as { commits: Array<{ seq: number; statusFrom: string | null; statusTo: string | null }> }).commits;
      if (commitList.length === 0) throw new Error("commit log empty");
      verdict("diagnostics retain replayable run ids, transition states and split details", true, `events=${eventList.length}, commits=${commitList.length}`);
    } catch (error) {
      verdict("diagnostics retain replayable run ids, transition states and split details", false, (error as Error).message);
    }

    heading("9. resource exhaustion and compute-failure classification");
    const lockedDir = mkdtempSync(join(tmpdir(), "nft-accept-lock-"));
    const lockedBuilt = await buildApp({ dbPath: join(lockedDir, "lock.db"), logFilePath: null, lockTimeoutMs: 200, sqliteBusyTimeoutMs: 20 });
    try {
      const lockEntered = deferred<void>();
      const releaseLock = deferred<void>();
      const holder = lockedBuilt.matcher.createBid(
        { kind: "create_bid", bidderId: "u_dave", collectionId: "col_punks", amount: 100 },
        { hooks: { afterBegin: () => { lockEntered.resolve(); return releaseLock.promise; } } },
      );
      await lockEntered.promise;
      const lockedInject = await lockedBuilt.app.inject({ method: "POST", url: "/v1/bids", payload: { bidderId: "u_alice", collectionId: "col_punks", amount: 100 } });
      const lockedResponse: ApiResponse = { status: lockedInject.statusCode, body: lockedInject.json() };
      responseLine(lockedResponse);
      try {
        expectStatus(lockedResponse, 503, "lock timeout");
        expectReason(lockedResponse, "lock_timeout", "lock timeout");
        verdict("lock wait exhaustion is 503 lock_timeout", true, "distinct from 409/500");
      } catch (error) {
        verdict("lock wait exhaustion is 503 lock_timeout", false, (error as Error).message);
      }
      releaseLock.resolve();
      await holder;
    } finally {
      await lockedBuilt.close();
      try { rmSync(lockedDir, { recursive: true, force: true }); } catch { /* disposable temp dir */ }
    }

    try {
      const { computeRoyaltyAmount } = await import("../src/contract/arithmetic.js");
      computeRoyaltyAmount(100, 10001);
      verdict("computation failure is classified as 500 invariant_violation", false, "no error thrown");
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 500 && error.reason === "invariant_violation") {
        verdict("computation failure is classified as 500 invariant_violation", true, error.message);
      } else {
        verdict("computation failure is classified as 500 invariant_violation", false, (error as Error).message);
      }
    }
  } finally {
    await built.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* disposable temp dir */ }
  }

  console.log(`\n${CYAN}=== SUMMARY ===${RESET}`);
  console.log(`${GREEN}passed: ${passedSteps}${RESET}, ${failures.length === 0 ? GREEN : RED}failed: ${failures.length}${RESET}`);
  if (failures.length > 0) {
    for (const name of failures) console.log(`${RED}FAILED SCENARIO: ${name}${RESET}`);
    return 1;
  }
  console.log(`${GREEN}ALL ACCEPTANCE SCENARIOS PASSED${RESET}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });

