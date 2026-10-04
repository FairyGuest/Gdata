import Fastify, { type FastifyInstance } from "fastify";
import { Ledger } from "./state/db.js";
import { DiagLog } from "./diag/index.js";
import { BidEngine, type KernelHooks } from "./kernel/engine.js";
import { parseCreateBid, parseCancelBid, parseAcceptBid } from "./contract/index.js";
import { isAppError, InputError } from "./errors.js";
import { seedFixtures } from "./fixtures.js";
import type { ServiceConfig } from "./config.js";

export interface BuiltApp {
  app: FastifyInstance;
  ledger: Ledger;
  engine: BidEngine;
  diag: DiagLog;
}

export function buildApp(config: ServiceConfig, hooks: KernelHooks = {}): BuiltApp {
  const ledger = new Ledger(config.dbPath);
  seedFixtures(ledger, config.seed);
  const diag = new DiagLog(ledger, config.runId);
  const engine = new BidEngine(ledger, diag, hooks);
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (isAppError(err)) {
      reply.status(err.statusCode).send({
        error: err.kind,
        reason: err.reason,
        message: err.message,
        details: err.details ?? null,
      });
      return;
    }
    reply.status(500).send({
      error: "internal",
      reason: "internal_error",
      message: String(err),
      details: null,
    });
  });

  app.get("/health", async () => ({ ok: true, runId: config.runId }));

  app.get("/fixtures/summary", async () => ({
    runId: config.runId,
    seed: config.seed,
    commitSeq: ledger.currentCommitSeq(),
    collections: ledger.listCollections(),
    tokens: ledger.listTokens(),
    accounts: ledger.listAccounts(),
    totalBalances: ledger.totalBalances(),
  }));

  app.post("/bids", async (req) => {
    const cmd = parseCreateBid(req.body, ledger);
    const bid = await engine.createBid(cmd);
    return { bid, frozen: bid.price };
  });

  app.post("/bids/:bidId/cancel", async (req) => {
    const cmd = parseCancelBid(req.params, req.body, ledger);
    const bid = await engine.cancelBid(cmd);
    return { bid, unfrozen: bid.price };
  });

  app.post("/bids/:bidId/accept", async (req) => {
    const cmd = parseAcceptBid(req.params, req.body, ledger);
    const fill = await engine.acceptBid(cmd);
    return { fill };
  });

  app.get("/bids/:bidId", async (req) => {
    const { bidId } = req.params as { bidId: string };
    const bid = ledger.getBid(bidId);
    if (!bid) throw new InputError("unknown_bid", "bid does not exist", { bidId });
    return { bid };
  });

  app.get("/accounts/:userId", async (req) => {
    const { userId } = req.params as { userId: string };
    const account = ledger.getAccount(userId);
    if (!account) throw new InputError("unknown_account", "account does not exist", { userId });
    return { account };
  });

  app.get("/diag/events", async (req) => {
    const { bidId } = req.query as { bidId?: string };
    return { runId: config.runId, events: diag.list(bidId) };
  });

  app.post("/admin/collections/:collectionId/royalty", async (req) => {
    const { collectionId } = req.params as { collectionId: string };
    const body = (req.body ?? {}) as { bps?: unknown; recipient?: unknown };
    if (
      typeof body.bps !== "number" ||
      !Number.isInteger(body.bps) ||
      body.bps < 0 ||
      body.bps > 10000
    ) {
      throw new InputError("invalid_royalty_bps", "bps must be an integer in [0, 10000]");
    }
    if (typeof body.recipient !== "string" || body.recipient.length === 0) {
      throw new InputError("invalid_field", "recipient must be a non-empty string");
    }
    if (!ledger.getCollection(collectionId)) {
      throw new InputError("unknown_collection", "collection does not exist", { collectionId });
    }
    ledger.updateCollectionRoyalty(collectionId, body.bps, body.recipient);
    return { collection: ledger.getCollection(collectionId) };
  });

  return { app, ledger, engine, diag };
}
