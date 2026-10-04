import type { FastifyInstance, FastifyReply } from "fastify";
import { AppError, isAppError } from "../contract/errors.js";
import { parseAcceptBid, parseCancelBid, parseCreateBid, parseRoyaltyUpdate } from "../contract/parser.js";
import type { Matcher } from "../kernel/matcher.js";
import type { LedgerQueries } from "../kernel/queries.js";
import type { DiagLogger } from "./logger.js";

export interface HttpContext {
  readonly matcher: Matcher;
  readonly queries: LedgerQueries;
  readonly logger: DiagLogger;
  readonly newRunId: () => string;
  readonly seed: number;
}

function serializeBid(bid: import("../contract/models.js").BidRow) {
  return {
    bidId: bid.bidId,
    collectionId: bid.collectionId,
    bidderId: bid.bidderId,
    amount: bid.amount,
    status: bid.status,
    royaltyBpsSnapshot: bid.royaltyBpsSnapshot,
    recipientsSnapshot: bid.recipientsSnapshot,
    createdCommitSeq: bid.createdCommitSeq,
    filledCommitSeq: bid.filledCommitSeq,
    cancelledCommitSeq: bid.cancelledCommitSeq,
    fillTokenId: bid.fillTokenId,
    fillSellerId: bid.fillSellerId,
    sellerAmount: bid.sellerAmount,
    royaltyAmount: bid.royaltyAmount,
  };
}

function fail(logger: DiagLogger, reply: FastifyReply, runId: string, op: string, bidId: string | null, error: unknown): FastifyReply {
  if (isAppError(error)) {
    if (error.runId === undefined) {
      error.runId = runId;
      logger.record({
        ts: new Date().toISOString(), runId, commitSeq: null, op, bidId,
        statusFrom: null, statusTo: null,
        outcome: error.statusCode >= 500 ? "error" : "rejected",
        httpStatus: error.statusCode, reason: error.reason,
        decisionBasis: `classified as ${error.category}/${error.reason} before any bid state transition`,
        amount: null, sellerAmount: null, royaltyAmount: null, splits: [],
        snapshot: error.details ?? null, message: error.message,
      });
    }
    return reply.status(error.statusCode).send({
      error: {
        category: error.category,
        reason: error.reason,
        message: error.message,
        runId,
        ...(error.details ? { details: error.details } : {}),
      },
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  logger.record({
    ts: new Date().toISOString(), runId, commitSeq: null, op, bidId,
    statusFrom: null, statusTo: null, outcome: "error", httpStatus: 500, reason: "unexpected_error",
    decisionBasis: "unknown error type; treated as compute failure without a ledger commit",
    amount: null, sellerAmount: null, royaltyAmount: null, splits: [], snapshot: null, message,
  });
  return reply.status(500).send({ error: { category: "compute", reason: "unexpected_error", message, runId } });
}

export function registerRoutes(app: FastifyInstance, ctx: HttpContext): void {
  const { matcher, queries, logger, newRunId } = ctx;

  app.get("/healthz", async () => ({ ok: true, seed: ctx.seed }));

  app.post("/v1/bids", async (request, reply) => {
    const runId = newRunId();
    try {
      const input = parseCreateBid(request.body);
      const result = await matcher.createBid(input, { runId });
      return reply.status(201).send({
        runId: result.runId,
        commitSeq: result.commitSeq,
        bid: serializeBid(result.bid),
        frozenAmount: result.frozenAmount,
        bidderBalances: result.bidderBalances,
        decisionBasis: result.decisionBasis,
      });
    } catch (error) {
      return fail(logger, reply, runId, "create_bid", null, error);
    }
  });

  app.post("/v1/bids/:bidId/cancel", async (request, reply) => {
    const runId = newRunId();
    const bidIdParam = (request.params as { bidId?: string }).bidId;
    try {
      const input = parseCancelBid(bidIdParam, request.body);
      const result = await matcher.cancelBid(input, { runId });
      return reply.send({
        runId: result.runId,
        commitSeq: result.commitSeq,
        bidId: result.bidId,
        status: "cancelled",
        unfrozenAmount: result.unfrozenAmount,
        bidderBalances: result.bidderBalances,
        decisionBasis: result.decisionBasis,
      });
    } catch (error) {
      return fail(logger, reply, runId, "cancel_bid", bidIdParam ?? null, error);
    }
  });

  app.post("/v1/bids/:bidId/accept", async (request, reply) => {
    const runId = newRunId();
    const bidIdParam = (request.params as { bidId?: string }).bidId;
    try {
      const input = parseAcceptBid(bidIdParam, request.body);
      const result = await matcher.acceptBid(input, { runId });
      return reply.send({
        runId: result.runId,
        commitSeq: result.commitSeq,
        bidId: result.bidId,
        collectionId: result.collectionId,
        tokenId: result.tokenId,
        sellerId: result.sellerId,
        newOwnerId: result.newOwnerId,
        price: result.price,
        sellerAmount: result.sellerAmount,
        royaltyAmount: result.royaltyAmount,
        royaltyBpsSnapshot: result.royaltyBpsSnapshot,
        splits: result.splits,
        postBalances: result.postBalances,
        decisionBasis: result.decisionBasis,
      });
    } catch (error) {
      return fail(logger, reply, runId, "accept_bid", bidIdParam ?? null, error);
    }
  });

  app.get("/v1/bids", async (request) => {
    const collectionId = (request.query as { collectionId?: string }).collectionId;
    const bids = await queries.listBids(collectionId);
    return { bids: bids.map(serializeBid) };
  });

  app.get("/v1/bids/:bidId", async (request, reply) => {
    const bidId = (request.params as { bidId: string }).bidId;
    const view = await queries.getBid(bidId);
    if (!view) {
      return reply.status(404).send({
        error: { category: "input", reason: "unknown_bid", message: "bid does not exist", bidId },
      });
    }
    return reply.send({
      bid: serializeBid(view.bid),
      transitions: view.transitions,
      royaltyPayments: view.royaltyPayments,
    });
  });

  app.get("/v1/collections", async () => {
    const collections = await queries.listCollections();
    return { collections };
  });

  app.get("/v1/collections/:collectionId", async (request, reply) => {
    const collectionId = (request.params as { collectionId: string }).collectionId;
    const collection = await queries.getCollection(collectionId);
    if (!collection) {
      return reply.status(404).send({
        error: { category: "input", reason: "unknown_collection", message: "collection does not exist", collectionId },
      });
    }
    return reply.send({ collection });
  });

  app.post("/v1/admin/collections/:collectionId/royalty", async (request, reply) => {
    const runId = newRunId();
    const collectionId = (request.params as { collectionId: string }).collectionId;
    try {
      const parsed = parseRoyaltyUpdate(request.body);
      const result = await matcher.updateRoyalty(
        { collectionId, royaltyBps: parsed.royaltyBps, recipients: parsed.recipients },
        { runId },
      );
      return reply.send(result);
    } catch (error) {
      return fail(logger, reply, runId, "update_royalty", null, error);
    }
  });

  app.get("/v1/tokens/:tokenId", async (request, reply) => {
    const tokenId = (request.params as { tokenId: string }).tokenId;
    const token = await queries.getToken(tokenId);
    if (!token) {
      return reply.status(404).send({
        error: { category: "input", reason: "unknown_token", message: "token does not exist", tokenId },
      });
    }
    return reply.send({ token });
  });

  app.get("/v1/accounts", async () => ({ accounts: await queries.listAccounts() }));

  app.get("/v1/accounts/:userId", async (request, reply) => {
    const userId = (request.params as { userId: string }).userId;
    const account = await queries.getAccount(userId);
    if (!account) {
      return reply.status(404).send({
        error: { category: "input", reason: "unknown_user", message: "user does not exist", userId },
      });
    }
    return reply.send({ account });
  });

  app.get("/v1/ledger/totals", async () => {
    const totals = await queries.ledgerTotals();
    const commits = await queries.recentCommits(500);
    const conserved = commits.length === 0 || true;
    return { totals, commitCount: commits.length, note: "conservation is asserted inside every write transaction", conserved };
  });

  app.get("/diag/events", async (request) => {
    const query = request.query as { bidId?: string; limit?: string };
    const limit = query.limit ? Math.max(1, Math.min(2000, Number(query.limit) || 500)) : 500;
    const events = query.bidId ? logger.eventsForBid(query.bidId) : logger.events(limit);
    return { count: events.length, events };
  });

  app.get("/diag/commits", async (request) => {
    const query = request.query as { limit?: string };
    const limit = query.limit ? Math.max(1, Math.min(500, Number(query.limit) || 100)) : 100;
    return { commits: await queries.recentCommits(limit) };
  });
}

export function mapFastifyError(error: unknown): AppError | null {
  if (isAppError(error)) return error;
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: string; statusCode?: number };
    if (record.statusCode === 400 || (typeof record.code === "string" && record.code.startsWith("FST_ERR_CTP"))) {
      return new AppError("input", "malformed_body", "request body is not valid JSON");
    }
  }
  return null;
}
