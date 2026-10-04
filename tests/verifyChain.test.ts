import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyChain, type VerifyOptions } from '../src/core/verifyChain.js';
import { FixedClock } from '../src/domain/clock.js';
import { signCertificate } from '../src/domain/signing.js';
import type { Certificate } from '../src/domain/types.js';
import { buildValidChain, DAY } from '../src/fixtures/ca.js';

const SECRET = 'test-master-secret';
const NOW = new Date('2026-06-15T00:00:00.000Z');

function opts(overrides: Partial<VerifyOptions> = {}): VerifyOptions {
  return {
    masterSecret: SECRET,
    trustedRoots: ['CN=Demo Root CA'],
    policy: { renewSoonDays: 30, renewImmediatelyDays: 7 },
    maxChainLength: 8,
    runId: 'test-run',
    ...overrides,
  };
}

function clone(c: Certificate): Certificate {
  return { ...c, keyUsage: [...c.keyUsage] };
}

// Re-signs a mutated certificate so tests can isolate non-signature failures.
function resign(cert: Certificate): Certificate {
  const { signature: _drop, ...rest } = cert;
  return { ...rest, signature: signCertificate(SECRET, rest) };
}

test('valid chain passes and reports per-link renewal advice', () => {
  const { chain } = buildValidChain(SECRET, NOW, 90);
  const res = verifyChain({ chain }, new FixedClock(NOW), opts());
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.chainLength, 3);
  assert.deepEqual(res.links.map((l) => l.index), [0, 1, 2]);
  assert.ok(res.links.every((l) => l.signatureValid && l.inValidityWindow));
  // leaf has 90 remaining days -> NONE
  const leaf = res.renewalAdvice[0];
  assert.equal(leaf.subject, 'CN=service.local');
  assert.equal(leaf.remainingDays, 90);
  assert.equal(leaf.action, 'NONE');
});

test('broken link is located at the exact chain level', () => {
  const { chain } = buildValidChain(SECRET, NOW);
  const leaf = clone(chain[0]);
  leaf.issuer = 'CN=Some Other CA'; // no longer matches intermediate subject
  chain[0] = resign(leaf);
  const res = verifyChain({ chain }, new FixedClock(NOW), opts());
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'CHAIN_LINK_MISMATCH');
  assert.equal(res.linkIndex, 0);
  assert.match(res.message, /Some Other CA/);
});

test('tampered certificate fails signature check at its level', () => {
  const { chain } = buildValidChain(SECRET, NOW);
  const intermediate = clone(chain[1]);
  intermediate.keyUsage = ['digitalSignature']; // mutated without re-signing
  chain[1] = intermediate;
  const res = verifyChain({ chain }, new FixedClock(NOW), opts());
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'SIGNATURE_INVALID');
  assert.equal(res.linkIndex, 1);
});

test('certificate expiring exactly now is treated as expired', () => {
  const { chain } = buildValidChain(SECRET, NOW);
  const leaf = clone(chain[0]);
  leaf.notAfter = NOW.toISOString(); // boundary: notAfter is exclusive
  chain[0] = resign(leaf);
  const res = verifyChain({ chain }, new FixedClock(NOW), opts());
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'CERT_EXPIRED');
  assert.equal(res.linkIndex, 0);
  assert.equal(res.links[0].remainingDays, 0);
});

test('certificate one millisecond before expiry still passes', () => {
  const { chain } = buildValidChain(SECRET, NOW);
  const leaf = clone(chain[0]);
  leaf.notAfter = new Date(NOW.getTime() + 1).toISOString();
  chain[0] = resign(leaf);
  const res = verifyChain({ chain }, new FixedClock(NOW), opts());
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.links[0].remainingDays, 0);
  assert.equal(res.links[0].renewalAction, 'RENEW_IMMEDIATELY');
});

test('renewal thresholds: 30d -> RENEW_SOON, 7d -> RENEW_IMMEDIATELY, 31d -> NONE', () => {
  const cases: Array<[number, string]> = [[30, 'RENEW_SOON'], [7, 'RENEW_IMMEDIATELY'], [31, 'NONE']];
  for (const [days, expected] of cases) {
    const { chain } = buildValidChain(SECRET, NOW);
    const leaf = clone(chain[0]);
    leaf.notAfter = new Date(NOW.getTime() + days * DAY).toISOString();
    chain[0] = resign(leaf);
    const res = verifyChain({ chain }, new FixedClock(NOW), opts());
    assert.equal(res.ok, true, `case ${days}d should pass`);
    if (!res.ok) continue;
    assert.equal(res.renewalAdvice[0].action, expected, `case ${days}d`);
    assert.equal(res.renewalAdvice[0].remainingDays, days);
  }
});

test('self-signed intermediate is rejected', () => {
  const { chain } = buildValidChain(SECRET, NOW);
  const intermediate = clone(chain[1]);
  intermediate.issuer = intermediate.subject; // self-issued
  chain[1] = resign(intermediate);
  const res = verifyChain({ chain }, new FixedClock(NOW), opts());
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'INTERMEDIATE_SELF_SIGNED');
  assert.equal(res.linkIndex, 1);
});

test('untrusted root is rejected', () => {
  const { chain } = buildValidChain(SECRET, NOW);
  const res = verifyChain({ chain }, new FixedClock(NOW), opts({ trustedRoots: ['CN=Other Root'] }));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'ROOT_UNTRUSTED');
  assert.equal(res.linkIndex, 2);
});

test('not-yet-valid certificate is rejected', () => {
  const { chain } = buildValidChain(SECRET, NOW);
  const leaf = clone(chain[0]);
  leaf.notBefore = new Date(NOW.getTime() + DAY).toISOString();
  chain[0] = resign(leaf);
  const res = verifyChain({ chain }, new FixedClock(NOW), opts());
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'CERT_NOT_YET_VALID');
  assert.equal(res.linkIndex, 0);
});

test('oversized chain is rejected as resource exhaustion', () => {
  const { chain } = buildValidChain(SECRET, NOW);
  const res = verifyChain({ chain }, new FixedClock(NOW), opts({ maxChainLength: 2 }));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'CHAIN_TOO_LONG');
  assert.equal(res.linkIndex, null);
});

test('malformed input is rejected as INPUT_INVALID', () => {
  const res = verifyChain({ chain: [{ serial: 1 }] }, new FixedClock(NOW), opts());
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, 'INPUT_INVALID');
  assert.equal(res.linkIndex, 0);
});

