import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeService, FIXTURE_TARGETS } from './helpers.ts';
import { buildApp } from '../src/http/app.ts';

test('HTTP API: register, event, run result, target diagnostics', async (t) => {
  const { service } = makeService();
  t.after(() => service.close());
  const app = buildApp(service);

  const reg = await app.inject({ method: 'POST', url: '/targets', payload: { targets: FIXTURE_TARGETS } });
  assert.equal(reg.statusCode, 200);
  assert.deepEqual(reg.json().registered, ['app', 'docs', 'extra', 'lib']);

  const ev = await app.inject({ method: 'POST', url: '/events', payload: { paths: ['src/lib.ts'] } });
  assert.equal(ev.statusCode, 200);
  const { runId, affected, order } = ev.json();
  assert.deepEqual(affected, ['app', 'extra', 'lib']);
  assert.deepEqual(order, ['lib', 'app', 'extra']);

  const run = await app.inject({ method: 'GET', url: `/runs/${runId}/wait` });
  assert.equal(run.statusCode, 200);
  assert.equal(run.json().status, 'completed');
  assert.equal(run.json().records.length, 3);

  const target = await app.inject({ method: 'GET', url: '/targets/lib' });
  assert.equal(target.statusCode, 200);
  assert.equal(target.json().lastBuild.outcome, 'success');

  const state = await app.inject({ method: 'GET', url: '/state' });
  assert.equal(state.json().targets.length, 4);
});

test('HTTP API: error categories map to distinct statuses and codes', async (t) => {
  const { service } = makeService();
  t.after(() => service.close());
  const app = buildApp(service);

  // events before registration -> 409 STATE_CONFLICT
  const early = await app.inject({ method: 'POST', url: '/events', payload: { paths: ['a'] } });
  assert.equal(early.statusCode, 409);
  assert.equal(early.json().error.code, 'STATE_CONFLICT');

  // invalid input -> 400 INPUT_ERROR
  const bad = await app.inject({ method: 'POST', url: '/targets', payload: { targets: [{ name: 'x', paths: ['../escape'], deps: [] }] } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'INPUT_ERROR');

  await app.inject({ method: 'POST', url: '/targets', payload: { targets: FIXTURE_TARGETS } });

  // unknown run -> 404 NOT_FOUND
  const nf = await app.inject({ method: 'GET', url: '/runs/4242' });
  assert.equal(nf.statusCode, 404);
  assert.equal(nf.json().error.code, 'NOT_FOUND');

  // unknown target -> 404 NOT_FOUND
  const nt = await app.inject({ method: 'GET', url: '/targets/ghost' });
  assert.equal(nt.statusCode, 404);
});