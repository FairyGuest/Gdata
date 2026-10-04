
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { Clock } from "./clock.ts";
import type { ServiceConfig, ClientRegistration } from "./config.ts";
import { parseAuthorizeRequest, parseTokenRequest } from "./contracts.ts";
import { OAuthKernel } from "./core.ts";
import { toOAuthError } from "./errors.ts";
import type { Store } from "./store.ts";

export interface BuildOptions {
  config: ServiceConfig;
  clock: Clock;
  store: Store;
  clients: ClientRegistration[];
  logger?: boolean;
}

export function buildServer(opts: BuildOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const kernel = new OAuthKernel(opts.store, opts.clock, opts.config, opts.clients);

  // Structured run log: every request gets a run id, key intermediate
  // state and the decision rationale are recorded for replay.
  app.addHook("onRequest", async (req) => {
    (req as unknown as { runId: string }).runId = randomUUID();
  });
  app.addHook("onResponse", async (req, reply) => {
    const runId = (req as unknown as { runId: string }).runId;
    app.log.info(
      {
        runId,
        method: req.method,
        url: req.url,
        status: reply.statusCode,
        clockNowSec: opts.clock.nowSec(),
      },
      "request completed",
    );
  });

  app.post("/authorize", async (req, reply) => {
    const runId = (req as unknown as { runId: string }).runId;
    try {
      const parsed = parseAuthorizeRequest((req.body ?? {}) as Record<string, unknown>);
      const result = kernel.authorize(parsed);
      return reply.send({ runId, ...result });
    } catch (e) {
      const err = toOAuthError(e);
      return reply.status(err.httpStatus).send({ runId, ...err.toJSON() });
    }
  });

  app.post("/token", async (req, reply) => {
    const runId = (req as unknown as { runId: string }).runId;
    try {
      const parsed = parseTokenRequest((req.body ?? {}) as Record<string, unknown>);
      const result =
        parsed.grantType === "authorization_code"
          ? kernel.exchangeCode(parsed as never)
          : kernel.refresh(parsed as never);
      return reply.send({ runId, ...result });
    } catch (e) {
      const err = toOAuthError(e);
      return reply.status(err.httpStatus).send({ runId, ...err.toJSON() });
    }
  });

  // Diagnostics: inspect stored state against the injected clock.
  app.get("/diagnostics/state", async (req) => {
    const runId = (req as unknown as { runId: string }).runId;
    const q = req.query as Record<string, string | undefined>;
    const now = opts.clock.nowSec();
    const out: Record<string, unknown> = { runId, clockNowSec: now };
    if (q.code) {
      const c = opts.store.getCode(q.code);
      out.code = c
        ? { ...c, expired: now >= c.expiresAt, consumed: c.consumedAt !== null }
        : null;
    }
    if (q.accessToken) {
      const t = opts.store.getAccessToken(q.accessToken);
      out.accessToken = t ? { ...t, expired: now >= t.expiresAt } : null;
    }
    if (q.refreshToken) {
      const r = opts.store.getRefreshToken(q.refreshToken);
      out.refreshToken = r
        ? { ...r, expired: now >= r.expiresAt, revoked: r.revokedAt !== null }
        : null;
    }
    return out;
  });

  return app;
}
