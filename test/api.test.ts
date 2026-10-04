import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../src/state/store.ts';
import { ScanEngine } from '../src/core/engine.ts';
import { buildServer } from '../src/api/server.ts';

let app;
let store;

before(async () => {
  store = new Store(':memory:');
  store.loadVulnDb('fixtures/vuln-db.json');
  const engine = new ScanEngine(store, { maxPackages: 1000, maxDepth: 32 });
  app = buildServer(engine, store);
});

after(async () => {
  await app.close();
  store.close();
});

function fixture(name) {
  return JSON.parse(readFileSync('fixtures/' + name, 'utf8'));
}

test('GET /health reports ok and vuln count', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.vulnerabilities, 8);
});

test('POST /scan returns sorted findings with dependency paths', async () => {
  const res = await app.inject({ method: 'POST', url: '/scan', payload: fixture('sbom-deep.json') });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'completed');
  assert.equal(body.findings[0].severity, 'critical');
  assert.equal(body.findings[0].vulnId, 'VULN-001');
  assert.deepEqual(body.findings[0].dependencyPath.at(-1), 'lib-deep@1.4.0');
});

test('POST /scan with invalid body returns 400 INPUT_ERROR', async () => {
  const res = await app.inject({ method: 'POST', url: '/scan', payload: { root: 42 } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.category, 'INPUT_ERROR');
});

test('POST /scan idempotency conflict returns 409 STATE_CONFLICT', async () => {
  const body = fixture('sbom-boundary-excluded.json');
  body.idempotencyKey = 'api-key-1';
  const first = await app.inject({ method: 'POST', url: '/scan', payload: body });
  assert.equal(first.statusCode, 200);
  const replay = await app.inject({ method: 'POST', url: '/scan', payload: body });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().runId, first.json().runId);

  const changed = fixture('sbom-boundary-excluded.json');
  changed.idempotencyKey = 'api-key-1';
  changed.packages[1].version = '9.9.9';
  changed.packages[0].dependencies['lib-edge'] = '9.9.9';
  const conflict = await app.inject({ method: 'POST', url: '/scan', payload: changed });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.category, 'STATE_CONFLICT');
});

test('GET /scan/:runId returns stored report, 404 for unknown', async () => {
  const created = await app.inject({ method: 'POST', url: '/scan', payload: fixture('sbom-ordering.json') });
  const runId = created.json().runId;
  const fetched = await app.inject({ method: 'GET', url: '/scan/' + runId });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json().runId, runId);

  const missing = await app.inject({ method: 'GET', url: '/scan/run-nope' });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.category, 'NOT_FOUND');
});

test('GET /diagnostics/runs/:runId/logs exposes replayable intermediate states', async () => {
  const created = await app.inject({ method: 'POST', url: '/scan', payload: fixture('sbom-deep.json') });
  const runId = created.json().runId;
  const res = await app.inject({ method: 'GET', url: '/diagnostics/runs/' + runId + '/logs' });
  assert.equal(res.statusCode, 200);
  const events = res.json().events;
  const steps = new Set(events.map((e) => e.step));
  for (const required of ['contract', 'graph', 'expand', 'cycle', 'match', 'done']) {
    assert.ok(steps.has(required), 'log must contain step "' + required + '"');
  }
  const cycleEvent = events.find((e) => e.step === 'cycle');
  assert.match(cycleEvent.detail, /lib-cycle2@1\.0\.0 -> lib-cycle@1\.0\.0/);

  const missing = await app.inject({ method: 'GET', url: '/diagnostics/runs/run-nope/logs' });
  assert.equal(missing.statusCode, 404);
});
