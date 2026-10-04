import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/http/server.js';
import { FixedClock } from '../src/domain/clock.js';
import { RunStore } from '../src/state/runStore.js';
import { buildValidChain } from '../src/fixtures/ca.js';
import { signCertificate } from '../src/domain/signing.js';
import type { ServiceConfig } from '../src/config.js';

const SECRET = 'api-test-secret';
const NOW = new Date('2026-06-15T00:00:00.000Z');

const config: ServiceConfig = {
  port: 0,
  host: '127.0.0.1',
  masterSecret: SECRET,
  trustedRoots: ['CN=Demo Root CA'],
  renewSoonDays: 30,
  renewImmediatelyDays: 7,
  maxChainLength: 8,
  dbPath: ':memory:',
};

let app: ReturnType<typeof buildApp>;

before(async () => {
  app = buildApp({ config, clock: new FixedClock(NOW), store: new RunStore(':memory:') });
  await app.ready();
});

after(async () => {
  await app.close();
});

test('POST /v1/verify accepts a valid chain and persists a replayable run', async () => {
  const { chain } = buildValidChain(SECRET, NOW);
  const res = await app.inject({ method: 'POST', url: '/v1/verify', payload: { chain } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.chainLength, 3);
  assert.ok(body.runId);

  const diag = await app.inject({ method: 'GET', url: `/v1/runs/${body.runId}` });
  assert.equal(diag.statusCode, 200);
  const stored = diag.json();
  assert.equal(stored.runId, body.runId);
  assert.equal(stored.ok, true);
  assert.equal(stored.steps.length, 3);
  assert.deepEqual(stored.steps.map((s: { outcome: string }) => s.outcome), ['pass', 'pass', 'pass']);
});

test('POST /v1/verify rejects a broken chain with 422 and a locatable failure', async () => {
  const { chain } = buildValidChain(SECRET, NOW);
  chain[1] = { ...chain[1], keyUsage: ['digitalSignature'] }; // tampered, not re-signed
  const res = await app.inject({ method: 'POST', url: '/v1/verify', payload: { chain } });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'SIGNATURE_INVALID');
  assert.equal(body.linkIndex, 1);

  const diag = await app.inject({ method: 'GET', url: `/v1/runs/${body.runId}` });
  const stored = diag.json();
  assert.equal(stored.ok, false);
  assert.equal(stored.code, 'SIGNATURE_INVALID');
  assert.ok(stored.steps.some((s: { check: string }) => s.check === 'verdict'));
});

test('POST /v1/verify rejects malformed payloads with 400 INPUT_INVALID', async () => {
  const res = await app.inject({ method: 'POST', url: '/v1/verify', payload: { chain: 'nope' } });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'INPUT_INVALID');
});

test('GET /v1/runs/:id returns 404 for unknown runs', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/runs/does-not-exist' });
  assert.equal(res.statusCode, 404);
});

test('signature fixture is stable across processes (deterministic HMAC)', () => {
  const { chain } = buildValidChain(SECRET, NOW);
  // Independently computed expectation, not derived from verifyChain internals.
  const { signature: _drop, ...unsigned } = chain[0];
  assert.equal(chain[0].signature, signCertificate(SECRET, unsigned));
  assert.match(chain[0].signature, /^[0-9a-f]{64}$/);
});

