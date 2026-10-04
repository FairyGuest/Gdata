import Fastify, { type FastifyInstance } from "fastify";
import { TokenService, validateIssueInput, validateTokenField } from "./service.ts";
import { HTTP_STATUS, type TokenError } from "./errors.ts";
import type { VirtualClock } from "./clock.ts";

export interface BuildOptions {
  service: TokenService;
  virtualClock?: VirtualClock;
}

function sendError(reply: any, err: TokenError) {
  return reply.status(HTTP_STATUS[err.error.code]).send({ error: err.error });
}

export function buildServer(opts: BuildOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const { service } = opts;

  app.post("/tokens", async (req, reply) => {
    const input = validateIssueInput(req.body);
    if (!input.ok) return sendError(reply, input);
    const r = service.issue(input.value);
    if (!r.ok) return sendError(reply, r);
    return reply.status(201).send(r.value);
  });

  app.post("/tokens/validate", async (req, reply) => {
    const token = validateTokenField(req.body);
    if (!token.ok) return sendError(reply, token);
    const r = service.validate(token.value);
    if (!r.ok) return sendError(reply, r);
    return reply.send({ valid: true, ...r.value });
  });

  app.post("/tokens/refresh", async (req, reply) => {
    const token = validateTokenField(req.body);
    if (!token.ok) return sendError(reply, token);
    const r = service.refresh(token.value);
    if (!r.ok) return sendError(reply, r);
    return reply.send(r.value);
  });

  app.post("/tokens/revoke", async (req, reply) => {
    const token = validateTokenField(req.body);
    if (!token.ok) return sendError(reply, token);
    const r = service.revoke(token.value);
    if (!r.ok) return sendError(reply, r);
    return reply.send(r.value);
  });

  // Diagnostics
  app.get("/health", async () => ({ status: "ok" }));

  app.get("/tokens/:jti", async (req, reply) => {
    const { jti } = req.params as { jti: string };
    const r = service.introspect(jti);
    if (!r.ok) return sendError(reply, r);
    return reply.send(r.value);
  });

  // Dev-only: exposed only when the service runs on a VirtualClock.
  if (opts.virtualClock) {
    const vc = opts.virtualClock;
    app.post("/__clock/advance", async (req) => {
      const ms = Number((req.body as any)?.ms);
      if (!Number.isFinite(ms) || ms < 0) {
        return { error: { code: "invalid_input", message: "ms must be a non-negative number" } };
      }
      return { now: vc.advance(ms) };
    });
    app.get("/__clock/now", async () => ({ now: vc.now() }));
  }

  return app;
}