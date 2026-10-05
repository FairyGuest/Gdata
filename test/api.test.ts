// API-level tests against a real HTTP server on an ephemeral port.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MutationStore } from '../src/store/sqlite.ts';
import { MutationService } from '../src/service.ts';
import { createHttpServer } from '../src/server/http.ts';
import { loadConfig } from '../src/config.ts';

let server: Server;
let base: string;

before(async () => {
  const svc = new MutationService(new MutationStore(':memory:'), loadConfig({ MTS_EXECUTOR: process.env.MTS_EXECUTOR ?? 'inprocess' }), () => {});
  server = createHttpServer(svc, () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});

after(() => server.close());

test('GET /health returns ok', async () => {
  const res = await fetch(base + '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('POST /runs executes a run and GET /runs/:id replays it', async () => {
  const res = await fetch(base + '/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectDir: 'fixtures/killed' }),
  });
  assert.equal(res.status, 201);
  const rec = await res.json() as any;
  assert.equal(rec.score, 1);
  assert.ok(rec.runId);

  const got = await fetch(base + '/runs/' + rec.runId);
  assert.equal(got.status, 200);
  const replay = await got.json() as any;
  assert.equal(replay.runId, rec.runId);
  assert.equal(replay.results.length, 1);
});

test('POST /runs with invalid JSON yields 400 INPUT_INVALID', async () => {
  const res = await fetch(base + '/runs', { method: 'POST', body: '{not json' });
  assert.equal(res.status, 400);
  const body = await res.json() as any;
  assert.equal(body.error.code, 'INPUT_INVALID');
});

test('POST /runs with missing projectDir yields 400 INPUT_INVALID', async () => {
  const res = await fetch(base + '/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json() as any).error.code, 'INPUT_INVALID');
});

test('GET /runs/:id with unknown id yields 404 NOT_FOUND', async () => {
  const res = await fetch(base + '/runs/00000000-0000-0000-0000-000000000000');
  assert.equal(res.status, 404);
  assert.equal((await res.json() as any).error.code, 'NOT_FOUND');
});

test('GET /mutants filters by type and rejects bad type', async () => {
  await fetch(base + '/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectDir: 'fixtures/sample' }),
  });
  const ok = await fetch(base + '/mutants?type=RemoveCall');
  assert.equal(ok.status, 200);
  const okBody = await ok.json() as any;
  assert.equal(okBody.count, 1);
  assert.equal(okBody.results[0].status, 'killed');

  const bad = await fetch(base + '/mutants?type=Bogus');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json() as any).error.code, 'INPUT_INVALID');
});

test('unknown route yields 404 NOT_FOUND', async () => {
  const res = await fetch(base + '/nope');
  assert.equal(res.status, 404);
  assert.equal((await res.json() as any).error.code, 'NOT_FOUND');
});

