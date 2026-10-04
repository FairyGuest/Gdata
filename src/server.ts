import Fastify from "fastify";
import type { AppConfig } from "./config.js";
import { openDb, type DB } from "./state/db.js";
import { parseFeed, parseReset, parseTokenParam } from "./contract/parse.js";
import { ApiError, computeFailure } from "./contract/errors.js";
import { feedToken, resetToken, getTokenState } from "./state/repo.js";
import { renderMetadata } from "./kernel/render.js";
import { getHistory, getLedger } from "./diag/queries.js";

export interface App {
  app: ReturnType<typeof Fastify>;
  db: DB;
}

export function buildApp(config: AppConfig): App {
  const db = openDb(config);
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).send(err.toBody());
    }
    const wrapped = computeFailure("internal_failure", err.message);
    return reply.status(500).send(wrapped.toBody());
  });

  app.post("/feed", async (req) => {
    const params = parseFeed(req.body, config.maxFeedAmount);
    return feedToken(db, params.tokenId, params.amount);
  });

  app.post("/reset", async (req) => {
    const params = parseReset(req.body, req.headers["x-admin-id"]);
    return resetToken(db, params.tokenId, params.adminId);
  });

  app.get("/tokens/:id/metadata", async (req) => {
    const tokenId = parseTokenParam((req.params as Record<string, unknown>).id);
    const { token, template } = getTokenState(db, tokenId);
    // Server renders the complete metadata document; clients never assemble it.
    return JSON.parse(renderMetadata(template, token.token_id, token.level, token.xp));
  });

  app.get("/diag/tokens/:id/history", async (req) => {
    const tokenId = parseTokenParam((req.params as Record<string, unknown>).id);
    getTokenState(db, tokenId); // 422 when token does not exist
    return { tokenId, transitions: getHistory(db, tokenId) };
  });

  app.get("/diag/tokens/:id/ledger", async (req) => {
    const tokenId = parseTokenParam((req.params as Record<string, unknown>).id);
    getTokenState(db, tokenId);
    return getLedger(db, tokenId);
  });

  return { app, db };
}
