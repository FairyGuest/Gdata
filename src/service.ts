import { randomUUID } from "node:crypto";
import type { Clock } from "./clock.ts";
import { signHs256, verifyHs256, type JwtClaims } from "./jwt.ts";
import { TokenStore, type TokenRow } from "./store.ts";
import { ok, fail, type Result } from "./errors.ts";

export interface IssuedToken {
  token: string;
  jti: string;
  sub: string;
  scope: string[];
  iat: number;
  exp: number;
}

export interface ValidatedToken {
  jti: string;
  sub: string;
  scope: string[];
  iat: number;
  exp: number;
}

export type DecisionEvent = {
  runId: string;
  op: string;
  jti?: string;
  decision: string;
  reason: string;
  at: number;
};

export type DecisionLogger = (e: DecisionEvent) => void;

export interface IssueInput {
  sub: string;
  scope: string[];
  ttlMs: number;
}

export function validateIssueInput(body: unknown): Result<IssueInput> {
  if (typeof body !== "object" || body === null) {
    return fail("invalid_input", "request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.sub !== "string" || b.sub.length === 0) {
    return fail("invalid_input", "sub must be a non-empty string");
  }
  if (
    !Array.isArray(b.scope) || b.scope.length === 0 ||
    !b.scope.every((s) => typeof s === "string" && s.length > 0)
  ) {
    return fail("invalid_input", "scope must be a non-empty array of non-empty strings");
  }
  if (typeof b.ttlMs !== "number" || !Number.isFinite(b.ttlMs) || b.ttlMs <= 0) {
    return fail("invalid_input", "ttlMs must be a positive finite number");
  }
  return ok({ sub: b.sub, scope: b.scope as string[], ttlMs: b.ttlMs });
}

export function validateTokenField(body: unknown): Result<string> {
  if (typeof body !== "object" || body === null) {
    return fail("invalid_input", "request body must be a JSON object");
  }
  const t = (body as Record<string, unknown>).token;
  if (typeof t !== "string" || t.length === 0) {
    return fail("invalid_input", "token must be a non-empty string");
  }
  return ok(t);
}

export class TokenService {
  constructor(
    private store: TokenStore,
    private clock: Clock,
    private secret: string,
    private runId: string,
    private log: DecisionLogger = () => {}
  ) {}

  private emit(op: string, decision: string, reason: string, jti?: string): void {
    this.log({ runId: this.runId, op, jti, decision, reason, at: this.clock.now() });
  }

  private issueFrom(input: IssueInput, forcedJti?: string): IssuedToken {
    const now = this.clock.now();
    const jti = forcedJti ?? randomUUID();
    const claims: JwtClaims = {
      sub: input.sub,
      jti,
      scope: input.scope,
      iat: now,
      exp: now + input.ttlMs,
    };
    const row: TokenRow = {
      jti,
      sub: claims.sub,
      scopes: JSON.stringify(claims.scope),
      iat: claims.iat,
      exp: claims.exp,
      status: "active",
      replaced_by: null,
    };
    this.store.insert(row);
    this.emit("issue", "issued", "token persisted as active", jti);
    return { token: signHs256(claims, this.secret), ...claims };
  }

  issue(input: IssueInput): Result<IssuedToken> {
    try {
      return ok(this.issueFrom(input));
    } catch (e) {
      this.emit("issue", "error", "store/compute failure: " + String(e));
      return fail("internal", "failed to issue token");
    }
  }

  private decode(token: string): Result<JwtClaims> {
    const v = verifyHs256(token, this.secret);
    if (!v.ok) {
      const msg =
        v.reason === "bad_signature"
          ? "signature verification failed"
          : v.reason === "bad_payload"
            ? "payload claims are malformed"
            : "token is not a well-formed JWT";
      this.emit("decode", "rejected", "verify failed: " + v.reason);
      return fail("invalid_token", msg, v.reason);
    }
    return ok(v.claims);
  }

  private lookup(jti: string): Result<TokenRow> {
    const row = this.store.get(jti);
    if (!row) {
      this.emit("lookup", "rejected", "jti not found in store", jti);
      return fail("invalid_token", "unknown token id", "unknown_jti");
    }
    return ok(row);
  }

  // Status is checked before expiry: revoked/rotated are explicit terminal
  // states and take precedence over the time-based check.
  private checkUsable(row: TokenRow, op: string): Result<TokenRow> {
    if (row.status === "revoked") {
      this.emit(op, "rejected", "token status is revoked", row.jti);
      return fail("revoked", "token has been revoked", "revoked");
    }
    if (row.status === "rotated") {
      this.emit(op, "rejected", "token status is rotated, replaced_by=" + row.replaced_by, row.jti);
      return fail("rotated", "token has been rotated (replaced by a refresh)", "rotated");
    }
    if (this.clock.now() >= row.exp) {
      this.emit(op, "rejected", "now >= exp (expired)", row.jti);
      return fail("expired", "token has expired", "expired");
    }
    return ok(row);
  }

  validate(token: string): Result<ValidatedToken> {
    const decoded = this.decode(token);
    if (!decoded.ok) return decoded;
    const row = this.lookup(decoded.value.jti);
    if (!row.ok) return row;
    const usable = this.checkUsable(row.value, "validate");
    if (!usable.ok) return usable;
    this.emit("validate", "accepted", "signature ok, status active, not expired", row.value.jti);
    return ok({
      jti: decoded.value.jti,
      sub: decoded.value.sub,
      scope: decoded.value.scope,
      iat: decoded.value.iat,
      exp: decoded.value.exp,
    });
  }

  refresh(token: string): Result<IssuedToken> {
    const decoded = this.decode(token);
    if (!decoded.ok) return decoded;
    const row = this.lookup(decoded.value.jti);
    if (!row.ok) return row;
    const usable = this.checkUsable(row.value, "refresh");
    if (!usable.ok) return usable;

    const newJti = randomUUID();
    // Atomic CAS: only the first concurrent refresh transitions active->rotated.
    const won = this.store.rotate(row.value.jti, newJti);
    if (!won) {
      const after = this.store.get(row.value.jti);
      const reason = after ? "status is now " + after.status : "row vanished";
      this.emit("refresh", "conflict", "lost CAS race: " + reason, row.value.jti);
      return fail(
        "refresh_conflict",
        "token was concurrently refreshed or revoked",
        after?.status ?? "unknown"
      );
    }

    const issued = this.issueFrom(
      {
        sub: decoded.value.sub,
        scope: decoded.value.scope,
        ttlMs: row.value.exp - row.value.iat,
      },
      newJti
    );
    this.emit("refresh", "rotated", "old token rotated, new jti=" + issued.jti, row.value.jti);
    return ok(issued);
  }

  revoke(token: string): Result<{ jti: string; status: "revoked" }> {
    const decoded = this.decode(token);
    if (!decoded.ok) return decoded;
    const row = this.lookup(decoded.value.jti);
    if (!row.ok) return row;
    if (row.value.status === "revoked") {
      this.emit("revoke", "rejected", "already revoked", row.value.jti);
      return fail("revoked", "token has been revoked", "revoked");
    }
    if (row.value.status === "rotated") {
      this.emit("revoke", "rejected", "already rotated", row.value.jti);
      return fail("rotated", "token has been rotated (replaced by a refresh)", "rotated");
    }
    const done = this.store.revoke(row.value.jti);
    if (!done) {
      const after = this.store.get(row.value.jti);
      this.emit("revoke", "conflict", "lost CAS race: status now " + after?.status, row.value.jti);
      return fail("refresh_conflict", "token state changed concurrently", after?.status ?? "unknown");
    }
    this.emit("revoke", "revoked", "status active->revoked", row.value.jti);
    return ok({ jti: row.value.jti, status: "revoked" });
  }

  introspect(jti: string): Result<TokenRow> {
    const row = this.store.get(jti);
    if (!row) return fail("invalid_token", "unknown token id", "unknown_jti");
    return ok(row);
  }
}