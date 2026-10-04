
import { VirtualClock } from "../src/clock.ts";
import { loadConfig, CLIENT_FIXTURES, type ServiceConfig } from "../src/config.ts";
import { SqliteStore } from "../src/store.ts";
import { buildServer } from "../src/server.ts";
import type { FastifyInstance } from "fastify";

export const VERIFIER = "test-verifier-42";
// Known-answer vector: base64url(SHA-256("test-verifier-42")), computed
// independently of the implementation under test.
export const CHALLENGE = "x8vG52ukahb_xp8Gz8KVy9ydVbpBWmExYObHQJz_dJM";
export const CLIENT_ID = "demo-client";
export const REDIRECT_URI = "http://localhost:8080/callback";

export interface Harness {
  app: FastifyInstance;
  clock: VirtualClock;
  store: SqliteStore;
  config: ServiceConfig;
}

export function makeHarness(overrides: Partial<ServiceConfig> = {}): Harness {
  const config: ServiceConfig = {
    ...loadConfig({}),
    dbPath: ":memory:",
    ...overrides,
  };
  const clock = new VirtualClock(1_700_000_000);
  const store = new SqliteStore(":memory:");
  const app = buildServer({ config, clock, store, clients: CLIENT_FIXTURES });
  return { app, clock, store, config };
}

export async function authorize(app: FastifyInstance, challenge = CHALLENGE) {
  const res = await app.inject({
    method: "POST",
    url: "/authorize",
    payload: {
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
    },
  });
  return res;
}

export async function exchange(
  app: FastifyInstance,
  code: string,
  verifier: string,
  redirectUri = REDIRECT_URI,
) {
  return app.inject({
    method: "POST",
    url: "/token",
    payload: {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    },
  });
}

export async function refresh(app: FastifyInstance, refreshToken: string) {
  return app.inject({
    method: "POST",
    url: "/token",
    payload: { grant_type: "refresh_token", refresh_token: refreshToken },
  });
}
