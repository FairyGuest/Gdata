import test from 'node:test';
import assert from 'node:assert/strict';
import { httpRequest, logStep, startChaos, startInjection, stopChaos, TARGET_BODY } from './helpers';

test('multiple faults inject simultaneously and recovery is full', async (t) => {
  const ctx = await startChaos();
  t.after(() => stopChaos(ctx));

  const delayMs = 120;
  const lat = await startInjection(ctx.base, { faultType: 'latency', probability: 1, params: { delayMs } });
  const err = await startInjection(ctx.base, { faultType: 'error_status', probability: 1, params: { statusCode: 503 } });
  assert.equal(lat.status, 201);
  assert.equal(err.status, 201);
  const latId = (lat.json.injection as { id: string }).id;
  const errId = (err.json.injection as { id: string }).id;
  logStep('multifault', 'both active', { latId, errId }, 'latency + error_status independent');

  const hit = await httpRequest(ctx.base + '/');
  logStep('multifault', 'combined request', { status: hit.status, elapsedMs: hit.elapsedMs },
    'expect 503 AND >= delayMs: both faults applied to same request');
  assert.equal(hit.status, 503);
  assert.ok(hit.elapsedMs >= delayMs - 10, 'latency fault missing: ' + hit.elapsedMs + 'ms');

  const errStats = await httpRequest(ctx.base + '/chaos/injections/' + errId + '/stats');
  const stats = JSON.parse(errStats.body).stats as { affectedRequests: number; totalRequestsDuringSession: number };
  logStep('multifault', 'stats', stats, 'affectedRequests must equal observed 503 count');
  assert.equal(stats.affectedRequests, 1);

  await httpRequest(ctx.base + '/chaos/stop-all', { method: 'POST' });
  const recovered = await httpRequest(ctx.base + '/');
  logStep('multifault', 'recovered', { status: recovered.status, elapsedMs: recovered.elapsedMs, bodyLen: recovered.body.length },
    'after stop-all: 200, full body, no delay');
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body, TARGET_BODY);
  assert.ok(recovered.elapsedMs < delayMs, 'latency persisted after stop-all');
});

test('truncate fault cuts the body, connection_reset kills the socket', async (t) => {
  const ctx = await startChaos();
  t.after(() => stopChaos(ctx));

  const trunc = await startInjection(ctx.base, { faultType: 'truncate', probability: 1, params: { keepRatio: 0.25 } });
  assert.equal(trunc.status, 201);
  const truncId = (trunc.json.injection as { id: string }).id;
  const cut = await httpRequest(ctx.base + '/');
  const expectedLen = Math.floor(TARGET_BODY.length * 0.25);
  logStep('truncate', 'truncated response', { got: cut.body.length, expected: expectedLen },
    'body length must equal floor(len * keepRatio)');
  assert.equal(cut.status, 200);
  assert.equal(cut.body.length, expectedLen);
  assert.equal(cut.body, TARGET_BODY.slice(0, expectedLen));
  await httpRequest(ctx.base + '/chaos/injections/' + truncId + '/stop', { method: 'POST' });

  const reset = await startInjection(ctx.base, { faultType: 'connection_reset', probability: 1 });
  assert.equal(reset.status, 201);
  const resetId = (reset.json.injection as { id: string }).id;
  const killed = await httpRequest(ctx.base + '/');
  logStep('reset', 'socket destroyed', { error: killed.error?.message ?? null, status: killed.status },
    'client must see a connection error, not an HTTP response');
  assert.ok(killed.error, 'expected a socket error');
  assert.equal(killed.status, 0);
  await httpRequest(ctx.base + '/chaos/injections/' + resetId + '/stop', { method: 'POST' });

  const recovered = await httpRequest(ctx.base + '/');
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body, TARGET_BODY);
  logStep('recovery', 'target intact', { status: recovered.status }, 'no permanent damage after faults stop');
});

test('error responses carry machine-readable categories', async (t) => {
  const ctx = await startChaos();
  t.after(() => stopChaos(ctx));

  const bad = await startInjection(ctx.base, { faultType: 'latency', probability: 2 });
  assert.equal(bad.status, 400);
  assert.equal((bad.json.error as { category: string }).category, 'input_error');

  const ok = await startInjection(ctx.base, { faultType: 'latency', probability: 1, params: { delayMs: 5 } });
  assert.equal(ok.status, 201);
  const dup = await startInjection(ctx.base, { faultType: 'latency', probability: 1, params: { delayMs: 5 } });
  assert.equal(dup.status, 409);
  assert.equal((dup.json.error as { category: string }).category, 'state_conflict');

  const missing = await httpRequest(ctx.base + '/chaos/injections/nope/stop', { method: 'POST' });
  assert.equal(missing.status, 409);
  assert.equal(JSON.parse(missing.body).error.category, 'state_conflict');
  logStep('api-errors', 'categories', { bad: 400, dup: 409, missing: 409 },
    'input/state errors distinguishable by category and HTTP status');
});