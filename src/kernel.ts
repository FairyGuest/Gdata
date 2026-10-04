/**
 * Execution kernel: JWT (HMAC-SHA256) minting/verification plus the
 * lifecycle state machine active -> rotated | revoked, with expiry
 * evaluated against the injected Clock. No I/O of its own: persistence
 * goes through TokenStore, time through Clock, audit through
 * DiagnosticLog. All failure exits are typed ServiceError values.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Clock } from './clock.ts';
import type { DiagnosticLog } from './diagnostics.ts';
import {
  ErrorCode,
  ServiceError,
  computationFailure,
  resourceExhausted,
  stateConflict,
  tokenFailure,
} from './errors.ts';
import type { TokenRecord, TokenStore } from './store.ts';

export interface KernelConfig {
  secret: string;
  maxActiveTokensPerSubject: number;
}

export interface IssuedToken {
  token: string;
  jti: string;
  subject: string;
  scopes: string[];
  issuedAtMs: number;
  expiresAtMs: number;
}

export interface VerifiedClaims {
  jti: string;
  subject: string;
  scopes: string[];
  issuedAtMs: number;
  expiresAtMs: number;
}

interface JwtPayload {
  jti: string;
  sub: string;
  scopes: string[];
  iat: number;
  exp: number;
}

const b64urlEncode = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url');

const b64urlDecode = (input: string): Buffer => Buffer.from(input, 'base64url');

export class TokenService {
  constructor(
    private readonly store: TokenStore,
    private readonly clock: Clock,
    private readonly log: DiagnosticLog,
    private readonly config: KernelConfig,
  ) {}

  private sign(data: string): string {
    try {
      return createHmac('sha256', this.config.secret).update(data).digest('base64url');
    } catch (err) {
      throw computationFailure('HMAC-SHA256 signing failed', { cause: String(err) });
    }
  }

  private mint(subject: string, scopes: string[], ttlSeconds: number): IssuedToken {
    const now = this.clock.now();
    const jti = randomUUID();
    const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload: JwtPayload = {
      jti,
      sub: subject,
      scopes,
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + ttlSeconds,
    };
    const body = header + '.' + b64urlEncode(JSON.stringify(payload));
    const token = body + '.' + this.sign(body);
    return {
      token,
      jti,
      subject,
      scopes: [...scopes],
      issuedAtMs: now,
      expiresAtMs: now + ttlSeconds * 1000,
    };
  }

  /** Decode + authenticate a JWT. Does NOT consult lifecycle state. */
  private authenticate(token: string): JwtPayload {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
      throw tokenFailure(ErrorCode.TOKEN_MALFORMED, 'token is not a three-part JWT');
    }
    const [header, payload, signature] = parts as [string, string, string];
    let headerObj: unknown;
    let payloadObj: unknown;
    try {
      headerObj = JSON.parse(b64urlDecode(header).toString('utf8'));
      payloadObj = JSON.parse(b64urlDecode(payload).toString('utf8'));
    } catch {
      throw tokenFailure(ErrorCode.TOKEN_MALFORMED, 'token header/payload are not valid JSON');
    }
    const alg = (headerObj as { alg?: unknown }).alg;
    if (alg !== 'HS256') {
      throw tokenFailure(ErrorCode.TOKEN_INVALID_SIGNATURE, 'unsupported alg: ' + String(alg));
    }
    const expected = this.sign(header + '.' + payload);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw tokenFailure(ErrorCode.TOKEN_INVALID_SIGNATURE, 'signature mismatch');
    }
    const p = payloadObj as Partial<JwtPayload>;
    if (
      typeof p.jti !== 'string' ||
      typeof p.sub !== 'string' ||
      !Array.isArray(p.scopes) ||
      typeof p.iat !== 'number' ||
      typeof p.exp !== 'number'
    ) {
      throw tokenFailure(ErrorCode.TOKEN_MALFORMED, 'token payload is missing required claims');
    }
    return p as JwtPayload;
  }

  /**
   * Resolve lifecycle state for an authenticated token. Order matters:
   * revoked/rotated are reported before expiry so callers can tell why a
   * token died even when several causes apply.
   */
  private lifecycleCheck(record: TokenRecord | null, jti: string, nowMs: number): TokenRecord {
    if (!record) {
      throw tokenFailure(ErrorCode.TOKEN_INVALID_SIGNATURE, 'unknown token id ' + jti);
    }
    if (record.status === 'revoked') {
      throw tokenFailure(ErrorCode.TOKEN_REVOKED, 'token was revoked', { jti });
    }
    if (record.status === 'rotated') {
      throw tokenFailure(ErrorCode.TOKEN_ROTATED, 'token was rotated and replaced', {
        jti,
        replacedBy: record.replacedBy,
      });
    }
    if (nowMs >= record.expiresAtMs) {
      throw tokenFailure(ErrorCode.TOKEN_EXPIRED, 'token expired', {
        jti,
        expiresAtMs: record.expiresAtMs,
        nowMs,
      });
    }
    return record;
  }

  issue(runId: string, subject: string, scopes: string[], ttlSeconds: number): IssuedToken {
    const active = this.store.countActiveBySubject(subject);
    if (active >= this.config.maxActiveTokensPerSubject) {
      const err = resourceExhausted(
        'subject already has ' + active + ' active tokens (max ' +
          this.config.maxActiveTokensPerSubject + ')',
        { subject, active },
      );
      this.log.record({
        runId, op: 'issue', jti: null, atMs: this.clock.now(),
        outcome: 'failure', reason: err.code,
        state: { subject, active, max: this.config.maxActiveTokensPerSubject },
      });
      throw err;
    }
    const issued = this.mint(subject, scopes, ttlSeconds);
    this.store.insert({
      jti: issued.jti,
      subject,
      scopes: issued.scopes,
      issuedAtMs: issued.issuedAtMs,
      expiresAtMs: issued.expiresAtMs,
      status: 'active',
      replacedBy: null,
    });
    this.log.record({
      runId, op: 'issue', jti: issued.jti, atMs: this.clock.now(),
      outcome: 'success', reason: null,
      state: { subject, scopes, expiresAtMs: issued.expiresAtMs },
    });
    return issued;
  }

  verify(runId: string, token: string): VerifiedClaims {
    try {
      const claims = this.authenticate(token);
      const record = this.store.get(claims.jti);
      this.lifecycleCheck(record, claims.jti, this.clock.now());
      this.log.record({
        runId, op: 'verify', jti: claims.jti, atMs: this.clock.now(),
        outcome: 'success', reason: null,
        state: { subject: claims.sub, status: record!.status },
      });
      return {
        jti: claims.jti,
        subject: claims.sub,
        scopes: claims.scopes,
        issuedAtMs: claims.iat * 1000,
        expiresAtMs: claims.exp * 1000,
      };
    } catch (err) {
      if (err instanceof ServiceError) {
        this.log.record({
          runId, op: 'verify', jti: (err.detail as { jti?: string })?.jti ?? null,
          atMs: this.clock.now(), outcome: 'failure', reason: err.code,
          state: { message: err.message, detail: err.detail ?? null },
        });
      }
      throw err;
    }
  }

  /**
   * Rotate: the old token is invalidated atomically and a fresh token is
   * issued with the same subject/scopes and a new TTL. If two refreshes
   * race, exactly one wins the conditional UPDATE; the loser gets
   * STATE_CONFLICT because the token is already rotated.
   */
  refresh(runId: string, token: string, ttlSeconds: number): IssuedToken {
    try {
      const claims = this.authenticate(token);
      const record = this.store.get(claims.jti);
      this.lifecycleCheck(record, claims.jti, this.clock.now());
      const next = this.mint(claims.sub, claims.scopes, ttlSeconds);
      const won = this.store.rotateIfActive(claims.jti, next.jti);
      if (!won) {
        throw stateConflict('refresh lost the race: token is no longer active', {
          jti: claims.jti,
        });
      }
      this.store.insert({
        jti: next.jti,
        subject: next.subject,
        scopes: next.scopes,
        issuedAtMs: next.issuedAtMs,
        expiresAtMs: next.expiresAtMs,
        status: 'active',
        replacedBy: null,
      });
      this.log.record({
        runId, op: 'refresh', jti: claims.jti, atMs: this.clock.now(),
        outcome: 'success', reason: null,
        state: { rotatedTo: next.jti, subject: claims.sub },
      });
      return next;
    } catch (err) {
      if (err instanceof ServiceError) {
        this.log.record({
          runId, op: 'refresh', jti: (err.detail as { jti?: string })?.jti ?? null,
          atMs: this.clock.now(), outcome: 'failure', reason: err.code,
          state: { message: err.message, detail: err.detail ?? null },
        });
      }
      throw err;
    }
  }

  /** Revoke is idempotent: revoking an already-revoked token succeeds. */
  revoke(runId: string, token: string): { jti: string; status: 'revoked'; alreadyRevoked: boolean } {
    try {
      const claims = this.authenticate(token);
      const record = this.store.get(claims.jti);
      if (!record) {
        throw tokenFailure(ErrorCode.TOKEN_INVALID_SIGNATURE, 'unknown token id ' + claims.jti);
      }
      if (record.status === 'rotated') {
        throw tokenFailure(ErrorCode.TOKEN_ROTATED, 'token was rotated and replaced', {
          jti: claims.jti,
          replacedBy: record.replacedBy,
        });
      }
      const alreadyRevoked = record.status === 'revoked';
      if (!alreadyRevoked) {
        const won = this.store.revokeIfActive(claims.jti);
        if (!won) {
          throw stateConflict('revoke lost the race: token is no longer active', {
            jti: claims.jti,
          });
        }
      }
      this.log.record({
        runId, op: 'revoke', jti: claims.jti, atMs: this.clock.now(),
        outcome: 'success', reason: null,
        state: { alreadyRevoked },
      });
      return { jti: claims.jti, status: 'revoked', alreadyRevoked };
    } catch (err) {
      if (err instanceof ServiceError) {
        this.log.record({
          runId, op: 'revoke', jti: (err.detail as { jti?: string })?.jti ?? null,
          atMs: this.clock.now(), outcome: 'failure', reason: err.code,
          state: { message: err.message, detail: err.detail ?? null },
        });
      }
      throw err;
    }
  }
}
