import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { AppConfig } from "./config.js";
import { TokenRepository } from "./state/repository.js";
import { Diagnostics } from "./diag/queries.js";
import { renderMetadata } from "./kernel/render.js";
import { parseFeed, parseMetadata, parseReset } from "./contract/parse.js";
import { AppError, computeFailure } from "./contract/errors.js";

export interface AppContext {
  runId: string;
  db: DatabaseSync;
  repo: TokenRepository;
  diag: Diagnostics;
  config: AppConfig;
}

export function buildServer(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      void reply.status(err.status).send({
        error: err.category,
        reason: err.reason,
        detail: err.detail,
        runId: ctx.runId,
      });
      return;
    }
    const wrapped = computeFailure("unexpected_internal_error", {
      message: err instanceof Error ? err.message : String(err),
    });
    void reply.status(wrapped.status).send({
      error: wrapped.category,
      reason: wrapped.reason,
      detail: wrapped.detail,
      runId: ctx.runId,
    });
  });

  app.post("/feed", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = parseFeed(req.body);
    const outcome = await ctx.repo.feed(
      ctx.runId,
      body.collectionId,
      body.tokenId,
      body.amount,
      ctx.config.feedLockMaxWaitMs,
    );
    return reply.status(200).send({
      ok: true,
      runId: ctx.runId,
      seq: outcome.seq,
      collectionId: body.collectionId,
      tokenId: body.tokenId,
      level: outcome.level,
      xp: outcome.xp,
      consumedXp: outcome.consumedXp,
      levelsGained: outcome.levelsGained,
    });
  });

  app.post("/reset", async (req: FastifyRequest, reply: FastifyReply) => {
    const headers = req.headers as Record<string, unknown>;
    const body = parseReset(req.body, headers);
    const result = ctx.repo.reset(ctx.runId, body.collectionId, body.tokenId, body.adminId);
    return reply.status(200).send({
      ok: true,
      runId: ctx.runId,
      collectionId: body.collectionId,
      tokenId: body.tokenId,
      level: 1,
      xp: 0,
      previous: result,
    });
  });

  app.get("/metadata/:collectionId/:tokenId", async (req: FastifyRequest, reply: FastifyReply) => {
    const params = parseMetadata(req.params as Record<string, unknown>);
    const collection = ctx.repo.getCollection(params.collectionId);
    const token = ctx.repo.getToken(params.collectionId, params.tokenId);
    const metadata = renderMetadata(
      {
        tokenId: token.tokenId,
        collectionId: token.collectionId,
        level: token.level,
        xp: token.xp,
      },
      collection.template,
    );
    return reply.status(200).header("content-type", "application/json").send(metadata);
  });

  app.get("/diag/token/:collectionId/:tokenId", async (req: FastifyRequest, reply: FastifyReply) => {
    const params = parseMetadata(req.params as Record<string, unknown>);
    const status = ctx.diag.tokenStatus(params.collectionId, params.tokenId);
    if (!status) {
      throw new AppError("conflict", "token_not_found", { ...params });
    }
    return reply.status(200).send({ runId: ctx.runId, status });
  });

  app.get("/diag/history/:collectionId/:tokenId", async (req: FastifyRequest, reply: FastifyReply) => {
    const params = parseMetadata(req.params as Record<string, unknown>);
    return reply.status(200).send({
      runId: ctx.runId,
      feeds: ctx.diag.feedHistory(params.collectionId, params.tokenId),
      levels: ctx.diag.levelHistory(params.collectionId, params.tokenId),
      ledger: ctx.diag.ledger(params.collectionId, params.tokenId),
    });
  });

  app.get("/healthz", async (_req, reply: FastifyReply) => {
    return reply.status(200).send({ ok: true, runId: ctx.runId });
  });

  return app;
}

