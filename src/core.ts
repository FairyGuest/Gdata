import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Clock } from "./clock.ts";
import type { ServiceConfig } from "./config.ts";
import type {
  AuditEvent,
  AuthorizeRequest,
  AuthorizeResult,
  ClientRegistration,
  IntrospectResult,
  TokenRequest,
  TokenResult,
} from "./contracts.ts";
import { Errors } from "./errors.ts";
import { StateStore, newTokenValue } from "./store.ts";

const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const S256_CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/;

export function computeS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export class AuditLog {
  private events: AuditEvent[] = [];
  private seq = 0;

  constructor(private readonly runId: string, private readonly clock: Clock) {}

  get id(): string {
    return this.runId;
  }

  record(action: string, outcome: "success" | "failure", reason: string, detail: Record<string, unknown> = {}): void {
    this.events.push({ runId: this.runId, seq: this.seq++, at: this.clock.now(), action, outcome, reason, detail });
  }

  list(): AuditEvent[] {
    return [...this.events];
  }
}

export interface CoreDeps {
  config: ServiceConfig;
  clock: Clock;
  store: StateStore;
  clients: ClientRegistration[];
  audit: AuditLog;
}

export class OAuth2Core {
  private readonly clientIndex: Map<string, ClientRegistration>;

  constructor(private readonly deps: CoreDeps) {
    this.clientIndex = new Map(deps.clients.map((c) => [c.clientId, c]));
  }



  authorize(req: AuthorizeRequest): AuthorizeResult {
    const { config, clock, store, audit } = this.deps;
    if (req.responseType !== "code") {
      audit.record("authorize", "failure", "unsupported response_type", { responseType: req.responseType });
      throw Errors.invalidRequest("response_type must be 'code', got '" + req.responseType + "'");
    }
    const client = this.clientIndex.get(req.clientId);
    if (!client) {
      audit.record("authorize", "failure", "unknown client", { clientId: req.clientId });
      throw Errors.invalidClient("unknown client_id: " + req.clientId);
    }
    if (!client.redirectUris.includes(req.redirectUri)) {
      audit.record("authorize", "failure", "redirect_uri mismatch", {
        clientId: req.clientId,
        redirectUri: req.redirectUri,
        registered: client.redirectUris,
      });
      throw Errors.invalidRequest("redirect_uri does not exactly match any registered URI");
    }
    if (req.codeChallengeMethod !== "S256") {
      audit.record("authorize", "failure", "unsupported code_challenge_method", { method: req.codeChallengeMethod });
      throw Errors.invalidRequest("code_challenge_method must be S256");
    }
    if (!S256_CHALLENGE_RE.test(req.codeChallenge)) {
      audit.record("authorize", "failure", "malformed code_challenge", {});
      throw Errors.invalidRequest("code_challenge must be a base64url sha256 digest (43 chars)");
    }
    const now = clock.now();
    const active = store.countActiveCodes(client.clientId, now);
    if (active >= config.maxCodesPerClient) {
      audit.record("authorize", "failure", "code quota exhausted", { clientId: client.clientId, active });
      throw Errors.resourceExhausted("too many outstanding authorization codes for client");
    }
    const code = newTokenValue("code");
    const rec = {
      code,
      clientId: client.clientId,
      redirectUri: req.redirectUri,
      codeChallenge: req.codeChallenge,
      scope: req.scope ?? "default",
      issuedAt: now,
      expiresAt: now + config.codeTtlMs,
      consumedAt: null,
    };
    store.insertCode(rec);
    audit.record("authorize", "success", "code issued", {
      clientId: client.clientId,
      codeSuffix: code.slice(-8),
      expiresAt: rec.expiresAt,
    });
    return { code, redirectUri: req.redirectUri, state: req.state, expiresInMs: config.codeTtlMs };
  }

  token(req: TokenRequest): TokenResult {
    switch (req.grantType) {
      case "authorization_code":
        return this.exchangeCode(req);
      case "refresh_token":
        return this.rotateRefreshToken(req);
      default:
        this.deps.audit.record("token", "failure", "unsupported grant_type", { grantType: req.grantType });
        throw Errors.unsupportedGrantType("grant_type must be authorization_code or refresh_token");
    }
  }

  private authenticateClient(req: TokenRequest): ClientRegistration {
    if (!req.clientId) throw Errors.invalidRequest("client_id is required");
    const client = this.clientIndex.get(req.clientId);
    if (!client) {
      this.deps.audit.record("token", "failure", "unknown client", { clientId: req.clientId });
      throw Errors.invalidClient("unknown client_id");
    }
    const a = Buffer.from(client.clientSecret);
    const b = Buffer.from(req.clientSecret ?? "");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.deps.audit.record("token", "failure", "bad client secret", { clientId: req.clientId });
      throw Errors.invalidClient("client authentication failed");
    }
    return client;
  }

  private exchangeCode(req: TokenRequest): TokenResult {
    const { config, clock, store, audit } = this.deps;
    const client = this.authenticateClient(req);
    if (!req.code) throw Errors.invalidRequest("code is required");
    const rec = store.getCode(req.code);
    if (!rec) {
      audit.record("exchange_code", "failure", "code not found", {});
      throw Errors.invalidGrant("authorization code not found");
    }
    if (rec.clientId !== client.clientId) {
      audit.record("exchange_code", "failure", "code belongs to another client", { clientId: client.clientId });
      throw Errors.invalidGrant("authorization code was not issued to this client");
    }
    if (rec.consumedAt !== null) {
      audit.record("exchange_code", "failure", "code already consumed", { consumedAt: rec.consumedAt });
      throw Errors.invalidGrant("authorization code has already been used");
    }
    const now = clock.now();
    if (rec.expiresAt <= now) {
      audit.record("exchange_code", "failure", "code expired", { expiresAt: rec.expiresAt, now });
      throw Errors.invalidGrant("authorization code expired");
    }
    if (!req.redirectUri || req.redirectUri !== rec.redirectUri) {
      audit.record("exchange_code", "failure", "redirect_uri mismatch on exchange", {});
      throw Errors.invalidGrant("redirect_uri does not match the one used at authorization");
    }
    if (!req.codeVerifier || !PKCE_VERIFIER_RE.test(req.codeVerifier)) {
      audit.record("exchange_code", "failure", "malformed code_verifier", {});
      throw Errors.invalidGrant("code_verifier missing or malformed (43-128 unreserved chars)");
    }
    const expected = computeS256(req.codeVerifier);
    const a = Buffer.from(expected);
    const b = Buffer.from(rec.codeChallenge);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      audit.record("exchange_code", "failure", "PKCE verification failed; code NOT consumed", {});
      throw Errors.invalidGrant("PKCE verification failed");
    }
    if (!store.consumeCode(rec.code, now)) {
      audit.record("exchange_code", "failure", "concurrent consume lost race", {});
      throw Errors.invalidGrant("authorization code has already been used");
    }
    const result = this.issueTokenPair(client.clientId, rec.scope, null);
    audit.record("exchange_code", "success", "code exchanged for token pair", {
      clientId: client.clientId,
      familyId: result.familyId,
    });
    return result.tokens;
  }

  private rotateRefreshToken(req: TokenRequest): TokenResult {
    const { clock, store, audit } = this.deps;
    const client = this.authenticateClient(req);
    if (!req.refreshToken) throw Errors.invalidRequest("refresh_token is required");
    const rec = store.getToken(req.refreshToken);
    if (!rec || rec.kind !== "refresh") {
      audit.record("refresh", "failure", "refresh token not found", {});
      throw Errors.invalidGrant("refresh token not found");
    }
    if (rec.clientId !== client.clientId) {
      audit.record("refresh", "failure", "refresh token belongs to another client", {});
      throw Errors.invalidGrant("refresh token was not issued to this client");
    }
    const now = clock.now();
    if (rec.consumedAt !== null) {
      const revoked = store.revokeFamily(rec.familyId, now);
      audit.record("refresh", "failure", "refresh token reuse detected; family revoked", {
        familyId: rec.familyId,
        revoked,
      });
      throw Errors.invalidGrant("refresh token already used (rotation reuse); token family revoked");
    }
    if (rec.expiresAt <= now) {
      audit.record("refresh", "failure", "refresh token expired", { expiresAt: rec.expiresAt, now });
      throw Errors.invalidGrant("refresh token expired");
    }
    if (!store.consumeRefreshToken(rec.token, now)) {
      audit.record("refresh", "failure", "concurrent rotation lost race", { familyId: rec.familyId });
      throw Errors.invalidGrant("refresh token already used (concurrent rotation)");
    }
    const result = this.issueTokenPair(client.clientId, rec.scope, rec.familyId);
    audit.record("refresh", "success", "refresh token rotated", { familyId: rec.familyId });
    return result.tokens;
  }

  private issueTokenPair(clientId: string, scope: string, familyId: string | null) {
    const { config, clock, store } = this.deps;
    const now = clock.now();
    const family = familyId ?? randomUUID();
    const accessToken = newTokenValue("at");
    const refreshToken = newTokenValue("rt");
    store.insertToken({
      token: accessToken,
      kind: "access",
      clientId,
      scope,
      issuedAt: now,
      expiresAt: now + config.accessTokenTtlMs,
      consumedAt: null,
      familyId: family,
    });
    store.insertToken({
      token: refreshToken,
      kind: "refresh",
      clientId,
      scope,
      issuedAt: now,
      expiresAt: now + config.refreshTokenTtlMs,
      consumedAt: null,
      familyId: family,
    });
    return {
      familyId: family,
      tokens: {
        accessToken,
        tokenType: "Bearer" as const,
        expiresInMs: config.accessTokenTtlMs,
        refreshToken,
        scope,
      },
    };
  }

  introspect(token: string): IntrospectResult {
    const { clock, store } = this.deps;
    const rec = store.getToken(token);
    if (!rec || rec.kind !== "access") return { active: false, reason: "unknown_token" };
    if (rec.consumedAt !== null) return { active: false, reason: "revoked" };
    if (rec.expiresAt <= clock.now()) return { active: false, reason: "expired" };
    return { active: true, clientId: rec.clientId, scope: rec.scope, expiresAt: rec.expiresAt };
  }
}

