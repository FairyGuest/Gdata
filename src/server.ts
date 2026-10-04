import Fastify, { type FastifyInstance } from "fastify";
import { VaultCore } from "./core.ts";
import { toVaultError } from "./errors.ts";
import type { SqliteStore } from "./store.ts";
import type { Clock } from "./clock.ts";

export interface ServerDeps {
  core: VaultCore;
  store: SqliteStore;
  clock: Clock;
  runId: string;
}

function actorOf(req: { headers: Record<string, unknown> }): string {
  const a = req.headers["x-actor"];
  return typeof a === "string" && a.length > 0 ? a : "anonymous";
}

/** Diagnostics + contract layer: HTTP <-> kernel. Error contract: { error: { code, message, details? } }. */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, req, reply) => {
    const fe = err as { statusCode?: number };
    if (fe.statusCode && fe.statusCode < 500) {
      reply.status(fe.statusCode).send({ error: { code: 'VALIDATION_ERROR', message: err.message } });
      return;
    }
    const ve = toVaultError(err);
    reply.status(ve.httpStatus).send({ error: { code: ve.code, message: ve.message, details: ve.details } });
  });

  app.put("/secrets/:name", async (req) => {
    const { name } = req.params as { name: string };
    const body = (req.body ?? {}) as { value?: unknown };
    const result = deps.core.putSecret(name, body.value, actorOf(req));
    return { statusCode: 201, data: result };
  });

  app.get("/secrets/:name", async (req) => {
    const { name } = req.params as { name: string };
    const { version } = req.query as { version?: string };
    return deps.core.getSecret(name, version, actorOf(req));
  });

  app.post("/secrets/:name/rotate", async (req) => {
    const { name } = req.params as { name: string };
    return deps.core.rotateSecret(name, actorOf(req));
  });

  app.get("/secrets/:name/versions", async (req) => {
    const { name } = req.params as { name: string };
    return { versions: deps.core.listVersions(name) };
  });

  app.get("/audit", async (req) => {
    const { name } = req.query as { name?: string };
    return { entries: deps.core.audit(name) };
  });

  app.get("/healthz", async () => ({
    status: "ok",
    runId: deps.runId,
    now: deps.clock.nowMs(),
    counts: deps.store.counts(),
  }));

  return app;
}
