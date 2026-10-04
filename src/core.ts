
import { createHash, randomBytes } from "node:crypto";
import type { Clock } from "./clock.ts";
import type { ServiceConfig, ClientRegistration } from "./config.ts";
import type { AuthorizeRequest, TokenRequest } from "./contracts.ts";
import { stateError } from "./errors.ts";
import type { Store } from "./store.ts";

export interface AuthorizeResult {
  code: string;
  redirectUri: string;
  expiresAt: number;
}

export interface TokenResult {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Execution kernel: pure orchestration over Clock + Store + Config.
 * Error contract: throws OAuthError (category "state") for all
 * domain conflicts; never swallows unknown failures.
 */
export class OAuthKernel {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly config: ServiceConfig;
  private readonly clients: ClientRegistration[];
  constructor(store: Store, clock: Clock, config: ServiceConfig, clients: ClientRegistration[]) {
    this.store = store;
    this.clock = clock;
    this.config = config;
    this.clients = clients;
  }

  authorize(req: AuthorizeRequest): AuthorizeResult {
    const client = this.clients.find((c) => c.clientId === req.clientId);
    if (!client) {
      throw stateError("unknown client_id", "unauthorized_client");
    }
    // exact string match, no normalization
    if (!client.redirectUris.includes(req.redirectUri)) {
      throw stateError("redirect_uri does not exactly match any registered URI");
    }
    const now = this.clock.nowSec();
    const rec = {
      code: newToken(),
      clientId: req.clientId,
      redirectUri: req.redirectUri,
      codeChallenge: req.codeChallenge,
      expiresAt: now + this.config.codeTtlSec,
      consumedAt: null,
    };
    this.store.insertCode(rec);
    return { code: rec.code, redirectUri: req.redirectUri, expiresAt: rec.expiresAt };
  }

  exchangeCode(req: Extract<TokenRequest, { grantType: "authorization_code" }>): TokenResult {
    const now = this.clock.nowSec();
    const rec = this.store.getCode(req.code!);
    if (!rec) {
      throw stateError("authorization code not found");
    }
    if (rec.consumedAt !== null) {
      throw stateError("authorization code already used");
    }
    if (now >= rec.expiresAt) {
      throw stateError("authorization code expired");
    }
    if (req.clientId !== rec.clientId) {
      throw stateError("client_id does not match the authorization code");
    }
    if (req.redirectUri !== rec.redirectUri) {
      throw stateError("redirect_uri does not match the authorization request");
    }
    // PKCE verified BEFORE consuming: a failed verifier leaves the code usable.
    if (s256(req.codeVerifier!) !== rec.codeChallenge) {
      throw stateError("PKCE code_verifier does not match code_challenge");
    }
    if (!this.store.consumeCode(rec.code, now)) {
      throw stateError("authorization code already used");
    }
    return this.issueTokens(rec.clientId, now);
  }

  refresh(req: Extract<TokenRequest, { grantType: "refresh_token" }>): TokenResult {
    const now = this.clock.nowSec();
    const rec = this.store.getRefreshToken(req.refreshToken!);
    if (!rec) {
      throw stateError("refresh token not found");
    }
    if (rec.revokedAt !== null) {
      throw stateError("refresh token already used (rotation reuse detected)");
    }
    if (now >= rec.expiresAt) {
      throw stateError("refresh token expired");
    }
    const next = {
      token: newToken(),
      clientId: rec.clientId,
      expiresAt: now + this.config.refreshTokenTtlSec,
      revokedAt: null,
    };
    // Atomic rotation: exactly one concurrent caller wins.
    if (!this.store.rotateRefreshToken(rec.token, next, now)) {
      throw stateError("refresh token already used (concurrent rotation)");
    }
    const access = {
      token: newToken(),
      clientId: rec.clientId,
      expiresAt: now + this.config.accessTokenTtlSec,
    };
    this.store.insertAccessToken(access);
    return {
      accessToken: access.token,
      tokenType: "Bearer",
      expiresIn: this.config.accessTokenTtlSec,
      accessExpiresAt: access.expiresAt,
      refreshToken: next.token,
      refreshExpiresAt: next.expiresAt,
    };
  }

  private issueTokens(clientId: string, now: number): TokenResult {
    const access = {
      token: newToken(),
      clientId,
      expiresAt: now + this.config.accessTokenTtlSec,
    };
    const refresh = {
      token: newToken(),
      clientId,
      expiresAt: now + this.config.refreshTokenTtlSec,
      revokedAt: null,
    };
    this.store.insertAccessToken(access);
    this.store.insertRefreshToken(refresh);
    return {
      accessToken: access.token,
      tokenType: "Bearer",
      expiresIn: this.config.accessTokenTtlSec,
      accessExpiresAt: access.expiresAt,
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt,
    };
  }
}
