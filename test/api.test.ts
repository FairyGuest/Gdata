import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildServer } from '../src/diag/server.ts';
import type { FastifyInstance } from 'fastify';

const fixture = (name: string) => JSON.parse(readFileSync(new URL('../fixtures/' + name, import.meta.url), 'utf8'));

let app: FastifyInstance;
let baseUrl: string;

before(async () => {
  app = buildServer({ dbPath: ':memory:' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'object' && address) baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await app.close();
});

test('evaluate endpoint merges, diffs, persists and replays a run', async () => {
  const body = {
    env: 'dev',
    layers: { base: fixture('base.json'), env: fixture('env.dev.json'), instance: fixture('instance.patch.json') },
    snapshot: fixture('snapshot.drifting.json'),
  };
  const res = await fetch(baseUrl + '/api/evaluations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.ok(data.runId);
  // effective config: deep merge + array replace + null delete combined
  assert.deepEqual(data.effective, {
    service: { name: 'checkout', port: 9090, replicas: 3 },
    features: { search: true },
    limits: { cpu: '1000m', memory: '256Mi' },
    tags: ['dev', 'canary'],
    logging: { level: 'debug', format: 'json' },
    instanceId: 'i-local-01',
  });
  assert.equal(data.drift.status, 'drifted');
  assert.deepEqual(
    data.drift.items.map((i: { category: string; path: string }) => [i.category, i.path]),
    [
      ['missing', 'limits.memory'],
      ['mismatch', 'service.port'],
      ['extra', 'runtime.node'],
    ],
  );

  // replay by run id returns the stored layered sources and drift result
  const replay = await fetch(baseUrl + '/api/runs/' + data.runId);
  assert.equal(replay.status, 200);
  const record = await replay.json();
  assert.equal(record.env, 'dev');
  assert.deepEqual(record.input.layers, body.layers);
  assert.deepEqual(record.output.drift, data.drift);

  // list by env
  const list = await fetch(baseUrl + '/api/runs?env=dev');
  const listed = await list.json();
  assert.ok(listed.runs.some((r: { runId: string }) => r.runId === data.runId));
});

test('clean snapshot yields explicit pass marker', async () => {
  const res = await fetch(baseUrl + '/api/evaluations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      env: 'dev',
      layers: { base: fixture('base.json'), env: fixture('env.dev.json'), instance: fixture('instance.patch.json') },
      snapshot: fixture('snapshot.clean.json'),
    }),
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.drift.status, 'pass');
  assert.deepEqual(data.drift.items, []);
});

test('invalid layer structure is rejected with layer name and path', async () => {
  const res = await fetch(baseUrl + '/api/evaluations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      env: 'dev',
      layers: { base: { a: 1 }, env: { bad: { '': 1 } }, instance: {} },
      snapshot: {},
    }),
  });
  assert.equal(res.status, 422);
  const data = await res.json();
  assert.equal(data.error.code, 'INVALID_LAYER');
  assert.equal(data.error.details.layer, 'env');
  assert.equal(data.error.details.path, 'bad');
});

test('non-object layer is rejected', async () => {
  const res = await fetch(baseUrl + '/api/evaluations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ env: 'dev', layers: { base: [], env: {}, instance: {} }, snapshot: {} }),
  });
  assert.equal(res.status, 422);
  const data = await res.json();
  assert.equal(data.error.code, 'INVALID_LAYER');
  assert.equal(data.error.details.layer, 'base');
});

test('missing run returns NOT_FOUND, not success', async () => {
  const res = await fetch(baseUrl + '/api/runs/does-not-exist');
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.error.code, 'NOT_FOUND');
});

test('missing fields are INVALID_INPUT', async () => {
  const res = await fetch(baseUrl + '/api/evaluations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ env: 'dev' }),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, 'INVALID_INPUT');
});
