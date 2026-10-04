/**
 * Lifecycle correctness tests. Expected values (expiry instants, claim
 * contents, error codes) are computed independently in the test, not
 * derived from the kernel under test.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VirtualClock } from '../src/clock.ts';
import { parseIssue } from '../src/contract.ts';
import { DiagnosticLog } from '../src/diagnostics.ts';
import { ErrorCode, ServiceError } from '../src/errors.ts';
import { TokenService } from '../src/kernel.ts';
import { TokenStore } from '../src/store.ts';

const T0 = 1_700_000_000_000; // fixed virtual epoch for all tests
const SECRET = 'test-secret';

function makeService(maxActive = 16) {
  const clock = new VirtualClock(T0);
  const store = new TokenStore(':memory:');
  const log = new DiagnosticLog();
  const service = new TokenService(store, clock, log, {
    secret: SECRET,
    maxActiveTokensPerSubject: maxActive,
  });
  return { clock, store, log, service };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ServiceError, 'expected ServiceError, got ' + String(err));
    return err.code;
  }
  throw new Error('expected call to throw');
}

test('issue then verify returns the exact claims that were requested', () => {
  const { service } = makeService();
  const issued = service.issue('run-1', 'alice', ['read:docs', 'write:docs'], 60);
  // Expected values computed independently of the kernel:
  assert.equal(issued.issuedAtMs, T0);
  assert.equal(issued.expiresAtMs, T0 + 60_000);
  const claims = service.verify('run-2', issued.token);
  assert.deepEqual(claims, {
    jti: issued.jti,
    subject: 'alice',
    scopes: ['read:docs', 'write:docs'],
    issuedAtMs: T0,
    expiresAtMs: T0 + 60_000,
  });
});

test('expiry boundary: valid 1ms before exp, TOKEN_EXPIRED exactly at exp', () => {
  const { service, clock } = makeService();
  const issued = service.issue('run-1', 'bob', ['read'], 10);
  clock.set(T0 + 10_000 - 1);
  assert.equal(service.verify('run-2', issued.token).jti, issued.jti);
  clock.set(T0 + 10_000);
  assert.equal(codeOf(() => service.verify('run-3', issued.token)), ErrorCode.TOKEN_EXPIRED);
  clock.set(T0 + 60_000);
  assert.equal(codeOf(() => service.verify('run-4', issued.token)), ErrorCode.TOKEN_EXPIRED);
});

test('revoked token verifies as TOKEN_REVOKED, even after it also expires', () => {
  const { service, clock } = makeService();
  const issued = service.issue('run-1', 'carol', ['read'], 10);
  const revoked = service.revoke('run-2', issued.token);
  assert.deepEqual(revoked, { jti: issued.jti, status: 'revoked', alreadyRevoked: false });
  assert.equal(codeOf(() => service.verify('run-3', issued.token)), ErrorCode.TOKEN_REVOKED);
  clock.set(T0 + 3600_000); // now also expired: revocation must still win
  assert.equal(codeOf(() => service.verify('run-4', issued.token)), ErrorCode.TOKEN_REVOKED);
  // revoke is idempotent
  assert.equal(service.revoke('run-5', issued.token).alreadyRevoked, true);
});

test('refresh rotates: old token becomes TOKEN_ROTATED, new token verifies', () => {
  const { service } = makeService();
  const first = service.issue('run-1', 'dave', ['read'], 100);
  const second = service.refresh('run-2', first.token, 200);
  assert.notEqual(second.jti, first.jti);
  assert.equal(second.expiresAtMs, T0 + 200_000);
  assert.equal(codeOf(() => service.verify('run-3', first.token)), ErrorCode.TOKEN_ROTATED);
  const claims = service.verify('run-4', second.token);
  assert.equal(claims.subject, 'dave');
  assert.deepEqual(claims.scopes, ['read']);
});

test('concurrent double refresh: exactly one succeeds, loser gets STATE_CONFLICT', async () => {
  const { service } = makeService();
  const issued = service.issue('run-1', 'erin', ['read'], 100);
  const results = await Promise.all([
    Promise.resolve().then(() => {
      try {
        return { ok: true as const, value: service.refresh('run-2a', issued.token, 100) };
      } catch (err) {
        return { ok: false as const, code: (err as ServiceError).code };
      }
    }),
    Promise.resolve().then(() => {
      try {
        return { ok: true as const, value: service.refresh('run-2b', issued.token, 100) };
      } catch (err) {
        return { ok: false as const, code: (err as ServiceError).code };
      }
    }),
  ]);
  const successes = results.filter((r) => r.ok);
  const failures = results.filter((r) => !r.ok);
  assert.equal(successes.length, 1, 'exactly one refresh may win');
  assert.equal(failures.length, 1);
  // The loser must fail with a lifecycle reason, never a generic error.
  assert.ok(
    failures[0]!.code === ErrorCode.STATE_CONFLICT ||
      failures[0]!.code === ErrorCode.TOKEN_ROTATED,
    'loser must see STATE_CONFLICT or TOKEN_ROTATED, got ' + failures[0]!.code,
  );
});

test('reusing a rotated token for refresh fails as TOKEN_ROTATED', () => {
  const { service } = makeService();
  const first = service.issue('run-1', 'frank', ['read'], 100);
  service.refresh('run-2', first.token, 100);
  assert.equal(codeOf(() => service.refresh('run-3', first.token, 100)), ErrorCode.TOKEN_ROTATED);
});

test('refreshing an expired token fails as TOKEN_EXPIRED', () => {
  const { service, clock } = makeService();
  const issued = service.issue('run-1', 'gina', ['read'], 5);
  clock.set(T0 + 5_000);
  assert.equal(codeOf(() => service.refresh('run-2', issued.token, 5)), ErrorCode.TOKEN_EXPIRED);
});

test('malformed and forged tokens are distinguished', () => {
  const { service } = makeService();
  assert.equal(codeOf(() => service.verify('run-1', 'not-a-jwt')), ErrorCode.TOKEN_MALFORMED);
  const issued = service.issue('run-2', 'henry', ['read'], 60);
  const forged = issued.token.slice(0, -2) + (issued.token.endsWith('aa') ? 'bb' : 'aa');
  assert.equal(
    codeOf(() => service.verify('run-3', forged)),
    ErrorCode.TOKEN_INVALID_SIGNATURE,
  );
});

test('contract layer rejects invalid issue payloads with VALIDATION_ERROR', () => {
  assert.equal(
    codeOf(() => parseIssue({ subject: 'x', ttlSeconds: 0, scopes: ['read'] }, 1000)),
    ErrorCode.VALIDATION_ERROR,
  );
  assert.equal(
    codeOf(() => parseIssue({ subject: 'x', ttlSeconds: 10, scopes: ['BAD SCOPE'] }, 1000)),
    ErrorCode.VALIDATION_ERROR,
  );
  assert.equal(
    codeOf(() => parseIssue({ subject: 'x', ttlSeconds: 10, scopes: ['a', 'a'] }, 1000)),
    ErrorCode.VALIDATION_ERROR,
  );
});

test('capacity guard reports RESOURCE_EXHAUSTED, not a generic failure', () => {
  const { service } = makeService(2);
  service.issue('run-1', 'ivan', ['read'], 100);
  service.issue('run-2', 'ivan', ['read'], 100);
  assert.equal(codeOf(() => service.issue('run-3', 'ivan', ['read'], 100)), ErrorCode.RESOURCE_EXHAUSTED);
  // a different subject is unaffected
  service.issue('run-4', 'judy', ['read'], 100);
});

test('diagnostics record run ids, outcomes and failure reasons for replay', () => {
  const { service, log } = makeService();
  const issued = service.issue('run-issue', 'kate', ['read'], 10);
  service.revoke('run-revoke', issued.token);
  codeOf(() => service.verify('run-verify', issued.token));
  const events = log.list();
  const verifyEvent = events.find((e) => e.runId === 'run-verify');
  assert.ok(verifyEvent, 'verify failure must be logged');
  assert.equal(verifyEvent.outcome, 'failure');
  assert.equal(verifyEvent.reason, ErrorCode.TOKEN_REVOKED);
  assert.equal(verifyEvent.jti, issued.jti);
  const revokeEvent = events.find((e) => e.runId === 'run-revoke');
  assert.equal(revokeEvent?.outcome, 'success');
  assert.deepEqual(
    events.map((e) => e.seq),
    events.map((_, i) => i + 1),
    'event sequence numbers must be contiguous',
  );
});
