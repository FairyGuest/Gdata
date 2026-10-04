import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.ts";
import { AppError } from "./contract/errors.ts";
import { ERROR_HTTP_STATUS, type Decision } from "./contract/types.ts";
import { parseCheckBody, parsePolicyBody, parseRoleBody } from "./contract/validate.ts";
import { decide } from "./core/engine.ts";
import { DecisionLog } from "./diagnostics/logger.ts";
import { PolicyStore } from "./state/store.ts";

export interface AppContext {
  app: FastifyInstance;
  store: PolicyStore;
  decisionLog: DecisionLog;
}

export function buildApp(config: AppConfig): AppContext {
  const store = new PolicyStore(config.dbPath, {
    maxRoles: config.maxRoles,
    maxPolicies: config.maxPolicies,
  });
  const decisionLog = new DecisionLog(config.decisionLogCapacity);
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      reply.status(ERROR_HTTP_STATUS[err.category]).send({
        error: { category: err.category, message: err.message, detail: err.detail ?? null },
      });
      return;
    }
    reply.status(500).send({
      error: { category: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err), detail: null },
    });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.put("/roles/:name", async (req) => {
    const { name } = req.params as { name: string };
    const body = parseRoleBody(req.body);
    return store.upsertRole(name, body.inherits);
  });

  app.delete("/roles/:name", async (req) => {
    const { name } = req.params as { name: string };
    const deleted = store.deleteRole(name);
    if (!deleted) {
      throw new AppError("STATE_CONFLICT", `role '${name}' not found`, { name });
    }
    return { deleted: true, name };
  });

  app.get("/roles", async () => store.snapshot().roles);

  app.put("/policies/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = parsePolicyBody(req.body);
    return store.putPolicy({ id, ...body });
  });

  app.delete("/policies/:id", async (req) => {
    const { id } = req.params as { id: string };
    const deleted = store.deletePolicy(id);
    if (!deleted) {
      throw new AppError("STATE_CONFLICT", `policy '${id}' not found`, { id });
    }
    return { deleted: true, id };
  });

  app.get("/policies", async () => store.snapshot().policies);

  app.post("/check", async (req) => {
    const checkReq = parseCheckBody(req.body);
    const snapshot = store.snapshot();
    let decision: Decision;
    try {
      decision = decide(checkReq, snapshot, {
        maxInheritanceDepth: config.maxInheritanceDepth,
        newRunId: () => decisionLog.newRunId(),
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError("INTERNAL_ERROR", "decision computation failed", String(err));
    }
    decisionLog.record(checkReq, decision);
    return decision;
  });

  app.get("/diagnostics/decisions", async (req) => {
    const { limit } = req.query as { limit?: string };
    return decisionLog.recent(limit ? Number(limit) : 50);
  });

  app.addHook("onClose", async () => store.close());
  return { app, store, decisionLog };
}

