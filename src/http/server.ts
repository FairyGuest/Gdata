import Fastify, { FastifyInstance } from "fastify";
import { Engine } from "../core/engine.js";
import { HistoryStore } from "../store/history.js";
import { parseCreateNamespace, parsePlaceWorkload, parseRegisterNode } from "../domain/validate.js";
import { ServiceError } from "../domain/types.js";
import { ServiceConfig } from "../config.js";

const STATUS_BY_KIND: Record<string, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  QUOTA_EXCEEDED: 422,
  NO_CAPACITY: 422,
};

export interface BuiltApp {
  app: FastifyInstance;
  engine: Engine;
  store: HistoryStore;
}

export function buildServer(config: ServiceConfig): BuiltApp {
  const store = new HistoryStore(config.dbPath);
  const engine = new Engine({ onEvent: (e) => store.record(e) });
  const app = Fastify({ logger: false });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ServiceError) {
      return reply.status(STATUS_BY_KIND[err.kind] ?? 500).send({
        error: { kind: err.kind, message: err.message, details: err.details ?? null },
      });
    }
    // contract parse failures from Fastify itself (bad JSON etc.)
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({
      error: { kind: status >= 500 ? "INTERNAL" : "VALIDATION", message: (err as Error).message, details: null },
    });
  });

  app.get("/health", async () => ({ ok: true, runId: engine.runId }));

  app.post("/nodes", async (req) => {
    const { id, capacity } = parseRegisterNode(req.body);
    const node = engine.registerNode(id, capacity);
    return { node };
  });

  app.post("/namespaces", async (req, reply) => {
    const { name, quota } = parseCreateNamespace(req.body);
    const ns = engine.createNamespace(name, quota);
    return reply.status(201).send({ namespace: ns });
  });

  app.delete("/namespaces/:name", async (req) => {
    const { name } = req.params as { name: string };
    const evictions = engine.deleteNamespace(name);
    return { deleted: name, evictions };
  });

  app.post("/workloads", async (req, reply) => {
    const { id, namespace, request } = parsePlaceWorkload(req.body);
    const decision = engine.placeWorkload(id, namespace, request);
    return reply.status(decision.outcome === "placed" ? 201 : 202).send({ decision });
  });

  app.delete("/workloads/:id", async (req) => {
    const { id } = req.params as { id: string };
    const result = engine.deleteWorkload(id);
    return { deleted: id, ...result };
  });

  // ---- diagnostics ----
  app.get("/diag/state", async () => ({
    runId: engine.runId,
    nodes: engine.getNodes(),
    namespaces: engine.getNamespaces(),
    workloads: engine.getWorkloads(),
    queue: engine.getQueue(),
    audit: engine.audit(),
  }));

  app.get("/diag/audit", async () => engine.audit());

  app.get("/diag/history", async (req) => {
    const q = req.query as { namespace?: string; nodeId?: string };
    return { history: store.history({ namespace: q.namespace, nodeId: q.nodeId }) };
  });

  return { app, engine, store };
}


