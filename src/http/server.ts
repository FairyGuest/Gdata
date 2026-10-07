// Diagnostic HTTP interface (Fastify). Maps domain error categories to
// distinct HTTP statuses; unknown errors are 500, never silently "ok".

import Fastify, { type FastifyInstance } from "fastify";
import { Engine } from "../core/engine.ts";
import { parseTargets } from "../core/graph.ts";
import { OrchestratorError } from "../domain/errors.ts";
import type { BuildStore } from "../store/sqlite.ts";
import type { RingLogger } from "../adapters/logger.ts";
import type { AppConfig } from "../config.ts";

const STATUS_BY_CATEGORY: Record<string, number> = {
  contract: 400,
  "state-conflict": 409,
  "resource-exhausted": 507,
  computation: 500,
  "not-found": 404,
};

export interface ServerDeps {
  engine: Engine;
  store: BuildStore;
  logger: RingLogger;
  config: AppConfig;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const { engine, store, logger, config } = deps;

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof OrchestratorError) {
      return reply.status(STATUS_BY_CATEGORY[err.category] ?? 500).send({
        error: { category: err.category, message: err.message },
      });
    }
    const anyErr = err as { statusCode?: number; message?: string };
    if (typeof anyErr.statusCode === "number" && anyErr.statusCode < 500) {
      return reply.status(anyErr.statusCode).send({
        error: { category: "contract", message: anyErr.message ?? "bad request" },
      });
    }
    return reply.status(500).send({
      error: { category: "computation", message: anyErr.message ?? "internal error" },
    });
  });

  app.get("/health", async () => ({ status: "ok", targetsRegistered: engine.hasGraph() }));

  // Register (or replace) the target definitions.
  app.post("/targets", async (req) => {
    const graph = parseTargets(req.body, config.maxTargets);
    engine.setGraph(graph);
    return { registered: [...graph.targets.keys()].sort() };
  });

  // Submit a batch of file-change events; resolves when the run settles.
  app.post("/events", async (req) => {
    const body = (req.body ?? {}) as { paths?: unknown };
    const report = await engine.submitChanges(body.paths);
    return report;
  });

  // Latest result + stored fingerprint for one target.
  app.get("/targets/:name", async (req) => {
    const { name } = req.params as { name: string };
    const latest = store.latestBuild(name);
    const fingerprint = store.getFingerprint(name);
    if (!latest && !fingerprint) {
      return { name, state: engine.targetState(name), fingerprint: null, latest: null };
    }
    return { name, state: engine.targetState(name), fingerprint, latest };
  });

  // Full build history (newest first), including skip records.
  app.get("/targets/:name/history", async (req) => {
    const { name } = req.params as { name: string };
    return { name, history: store.history(name) };
  });

  app.get("/runs", async () => ({ runs: engine.listRuns() }));

  app.get("/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = engine.getRun(id);
    if (!run) {
      return reply.status(404).send({ error: { category: "not-found", message: "unknown run: " + id } });
    }
    return run;
  });

  // Structured diagnostic log, optionally filtered by runId.
  app.get("/logs", async (req) => {
    const { runId } = req.query as { runId?: string };
    return { entries: logger.query(runId) };
  });

  return app;
}
