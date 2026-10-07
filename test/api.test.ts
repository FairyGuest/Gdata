import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildServer } from '../src/server.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

test('full API flow: register, plan, startup, impact, diagnostics, version query', async () => {
  const { app } = buildServer({ dbPath: ':memory:' });

  const created = await app.inject({ method: 'POST', url: '/orchestrations', payload: fixture('valid-multi-layer.json') });
  assert.equal(created.statusCode, 201);
  const createdBody = created.json();
  assert.equal(createdBody.version, 1);
  assert.deepEqual(createdBody.startOrder, ['cache', 'db', 'api', 'worker', 'gateway']);
  assert.deepEqual(createdBody.stopOrder, ['gateway', 'worker', 'api', 'db', 'cache']);
  assert.ok(createdBody.runId);

  const plan = await app.inject({ method: 'GET', url: '/orchestrations/1/plan' });
  assert.equal(plan.statusCode, 200);
  assert.deepEqual(plan.json().startOrder, createdBody.startOrder);

  const startup = await app.inject({ method: 'POST', url: '/orchestrations/1/startup' });
  assert.equal(startup.statusCode, 200);
  assert.equal(startup.json().status, 'completed');

  const impact = await app.inject({
    method: 'POST',
    url: '/orchestrations/1/impact',
    payload: { changedService: 'db' },
  });
  assert.equal(impact.statusCode, 200);
  assert.deepEqual(impact.json().affected, ['api', 'db', 'gateway', 'worker']);
  assert.deepEqual(impact.json().skipped, ['cache']);

  const run = await app.inject({ method: 'GET', url: `/runs/${createdBody.runId}` });
  assert.equal(run.statusCode, 200);
  assert.equal(run.json().kind, 'plan');
  assert.ok(run.json().log.some((l: string) => l.includes('stage=plan')));

  await app.close();
});

test('validation failures map to distinct error categories over HTTP', async () => {
  const { app } = buildServer({ dbPath: ':memory:' });
  const cases = [
    { fixture: 'cycle.json', status: 422, code: 'VALIDATION_CYCLE' },
    { fixture: 'port-conflict.json', status: 422, code: 'VALIDATION_PORT_CONFLICT' },
    { fixture: 'missing-env.json', status: 422, code: 'VALIDATION_MISSING_ENV' },
  ];
  for (const c of cases) {
    const res = await app.inject({ method: 'POST', url: '/orchestrations', payload: fixture(c.fixture) });
    assert.equal(res.statusCode, c.status, c.fixture);
    assert.equal(res.json().error.code, c.code, c.fixture);
  }
  await app.close();
});

test('cycle error response includes the cycle sequence', async () => {
  const { app } = buildServer({ dbPath: ':memory:' });
  const res = await app.inject({ method: 'POST', url: '/orchestrations', payload: fixture('cycle.json') });
  assert.deepEqual(res.json().error.details.cycle, ['a', 'c', 'b', 'a']);
  await app.close();
});

test('malformed JSON body is a CONTRACT_PARSE_ERROR, not a crash', async () => {
  const { app } = buildServer({ dbPath: ':memory:' });
  const res = await app.inject({
    method: 'POST',
    url: '/orchestrations',
    headers: { 'content-type': 'application/json' },
    payload: '{not json',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'CONTRACT_PARSE_ERROR');
  await app.close();
});

test('oversized body is reported as RESOURCE_EXHAUSTED', async () => {
  const { app } = buildServer({ dbPath: ':memory:', bodyLimit: 256 });
  const res = await app.inject({
    method: 'POST',
    url: '/orchestrations',
    payload: { name: 'x', services: [], padding: 'y'.repeat(1000) },
  });
  assert.equal(res.statusCode, 507);
  assert.equal(res.json().error.code, 'RESOURCE_EXHAUSTED');
  await app.close();
});

test('unknown version and unknown run are NOT_FOUND / STATE_CONFLICT', async () => {
  const { app } = buildServer({ dbPath: ':memory:' });
  const missing = await app.inject({ method: 'GET', url: '/orchestrations/99/plan' });
  assert.equal(missing.statusCode, 409);
  assert.equal(missing.json().error.code, 'STATE_CONFLICT');

  const created = await app.inject({ method: 'POST', url: '/orchestrations', payload: fixture('valid-multi-layer.json') });
  const version = created.json().version;
  const noStartup = await app.inject({ method: 'GET', url: '/orchestrations/999/plan' });
  assert.equal(noStartup.statusCode, 409);

  const impact = await app.inject({
    method: 'POST',
    url: `/orchestrations/${version}/impact`,
    payload: { changedService: 'ghost' },
  });
  assert.equal(impact.statusCode, 404);
  assert.equal(impact.json().error.code, 'NOT_FOUND');

  const run = await app.inject({ method: 'GET', url: '/runs/does-not-exist' });
  assert.equal(run.statusCode, 404);
  await app.close();
});

test('failing health fixture surfaces failure location via API', async () => {
  const { app } = buildServer({ dbPath: ':memory:' });
  const created = await app.inject({ method: 'POST', url: '/orchestrations', payload: fixture('failing-health.json') });
  assert.equal(created.statusCode, 201);
  const version = created.json().version;
  const startup = await app.inject({ method: 'POST', url: `/orchestrations/${version}/startup` });
  assert.equal(startup.statusCode, 200);
  const body = startup.json();
  assert.equal(body.status, 'failed');
  assert.equal(body.failure.layer, 1);
  assert.deepEqual(body.failure.services, ['api']);
  await app.close();
});
