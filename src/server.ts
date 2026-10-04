import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { Clock } from "./clock.ts";
import type { ServiceConfig } from "./config.ts";
import type { AuthorizeRequest, TokenRequest } from "./contracts.ts";
import { toOAuthError } from "./errors.ts";
import { AuditLog, OAuth2Core } from "./core.ts";
import { StateStore } from "./store.ts";
import { FIXTURE_CLIENTS } from "./fixtures.ts";

export interface BuildAppOptions {
  config: ServiceConfig;
  clock: Clock;
  store?: StateStore;
  runId?: string;
}

export interface BuiltApp {
  app: FastifyInstance;
  core: OAuth2Core;
  store: StateStore;
  audit: AuditLog;
  runId: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function buildApp(opts: BuildAppOptions): BuiltApp {
  const runId = opts.runId ?? randomUUID();
  const store = opts.store ?? new StateStore(opts.config.dbPath);
  const audit = new AuditLog(runId, opts.clock);
  const core = new OAuth2Core({
    config: opts.config,
    clock: opts.clock,
    store,
    clients: FIXTURE_CLIENTS,
    audit,
  });

  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    const oauthErr = toOAuthError(err);
    audit.record("http", "failure", oauthErr.spec.errorDescription, { error: oauthErr.spec.error });
    void reply.status(oauthErr.spec.httpStatus).send(oauthErr.toJSON());
  });

  app.get("/authorize", async (req) => {
    const q = req.query as Record<string, unknown>;
    const result = core.authorize({
      responseType: str(q.response_type) ?? "",
      clientId: str(q.client_id) ?? "",
      redirectUri: str(q.redirect_uri) ?? "",
      codeChallenge: str(q.code_challenge) ?? "",
      codeChallengeMethod: str(q.code_challenge_method) ?? "",
      scope: str(q.scope),
      state: str(q.state),
    } satisfies AuthorizeRequest);
    const url = new URL(result.redirectUri);
    url.searchParams.set("code", result.code);
    if (result.state !== undefined) url.searchParams.set("state", result.state);
    return {
      code: result.code,
      redirect: url.toString(),
      expires_in_ms: result.expiresInMs,
    };
  });

  app.post("/token", async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = core.token({
      grantType: str(b.grant_type) ?? "",
      code: str(b.code),
      redirectUri: str(b.redirect_uri),
      clientId: str(b.client_id),
      clientSecret: str(b.client_secret),
      codeVerifier: str(b.code_verifier),
      refreshToken: str(b.refresh_token),
    } satisfies TokenRequest);
    return {
      access_token: result.accessToken,
      token_type: result.tokenType,
      expires_in_ms: result.expiresInMs,
      refresh_token: result.refreshToken,
      scope: result.scope,
    };
  });

  app.post("/introspect", async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const token = str(b.token);
    if (!token) return { active: false, reason: "missing_token" };
    return core.introspect(token);
  });

  app.get("/diag/health", async () => ({ status: "ok", runId, now: opts.clock.now() }));

  app.get("/diag/state", async () => ({
    runId,
    now: opts.clock.now(),
    store: store.stats(opts.clock.now()),
  }));

  app.get("/diag/audit", async () => ({ runId, events: audit.list() }));

  return { app, core, store, audit, runId };
}
