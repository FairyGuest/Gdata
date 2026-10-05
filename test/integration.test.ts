// Integration tests: real target + real proxy. Verifies timing, fault effects,
// simultaneous faults, recovery after stop, and sqlite history counts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startService, type RunningService } from '../src/server.ts';
import { startTarget } from '../src/target.ts';

let svc: RunningService;
let target: Awaited<ReturnType<typeof startTarget>>;
let base: string;

before(async () => {
  target = await startTarget(0);
  svc = await startService({ proxyPort: 0, targetUrl: `http://127.0.0.1:${target.port}`, dbPath: ':memory:', initialFaults: {} });
  base = `http://127.0.0.1:${svc.port}`;
});
after(async () => { await svc.close(); target.server.closeAllConnections(); target.server.close(); });

const api = async (path: string, method = 'GET', body?: unknown) => {
  const res = await fetch(base + path, { method, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};

test('baseline: no faults -> clean pass-through', async () => {
  const res = await fetch(base + '/api/hello');
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.message, 'hello from target');
  assert.ok(j.padding.length === 1000);
});

test('latency injection: measured delay >= injected delay; recovery after stop', async () => {
  const { json } = await api('/chaos/faults/latency/start', 'POST', { probability: 1, params: { delayMs: 250 } });
  const sessionId = json.started.sessionId as string;

  const t0 = performance.now();
  const res = await fetch(base + '/api/hello');
  const elapsed = performance.now() - t0;
  assert.equal(res.status, 200);
  assert.ok(elapsed >= 240, `elapsed ${elapsed}ms < injected 250ms`);

  const stats = await api(`/chaos/sessions/${sessionId}`);
  assert.equal(stats.json.affectedRequests, 1);
  assert.ok(stats.json.events[0].durationMs >= 240, 'recorded duration must reflect real sleep');

  await api('/chaos/faults/latency/stop', 'POST');
  const t1 = performance.now();
  await fetch(base + '/api/hello');
  const elapsed2 = performance.now() - t1;
  assert.ok(elapsed2 < 200, `after stop elapsed ${elapsed2}ms, target not recovered`);
});

test('errorStatus injection: short-circuits with configured status, then recovers', async () => {
  await api('/chaos/faults/errorStatus/start', 'POST', { probability: 1, params: { statusCode: 503 } });
  const res = await fetch(base + '/api/hello');
  assert.equal(res.status, 503);
  const j = await res.json();
  assert.equal(j.error.code, 'INJECTED_FAULT');
  await api('/chaos/faults/errorStatus/stop', 'POST');
  const res2 = await fetch(base + '/api/hello');
  assert.equal(res2.status, 200);
});

test('truncate injection: body is cut to keepRatio, then recovers', async () => {
  await api('/chaos/faults/truncate/start', 'POST', { probability: 1, params: { keepRatio: 0.2 } });
  const res = await fetch(base + '/api/hello');
  const text = await res.text();
  const full = await (await fetch(`http://127.0.0.1:${target.port}/api/hello`)).text();
  assert.ok(text.length < full.length * 0.25, `len ${text.length} not truncated vs ${full.length}`);
  await api('/chaos/faults/truncate/stop', 'POST');
  const res2 = await fetch(base + '/api/hello');
  const j = await res2.json();
  assert.equal(j.padding.length, 1000, 'full body must be restored after stop');
});

test('abort injection: connection destroyed, then recovers', async () => {
  await api('/chaos/faults/abort/start', 'POST', { probability: 1 });
  await assert.rejects(fetch(base + '/api/hello'), /fetch failed|socket|terminated|ECONNRESET/i);
  await api('/chaos/faults/abort/stop', 'POST');
  const res = await fetch(base + '/api/hello');
  assert.equal(res.status, 200);
});

test('multiple faults simultaneously, each independently controlled', async () => {
  await api('/chaos/faults/latency/start', 'POST', { probability: 1, params: { delayMs: 120 } });
  const { json } = await api('/chaos/faults/errorStatus/start', 'POST', { probability: 1, params: { statusCode: 502 } });
  const status = await api('/chaos/status');
  assert.equal(status.json.active.length, 2);

  const t0 = performance.now();
  const res = await fetch(base + '/api/hello');
  const elapsed = performance.now() - t0;
  assert.equal(res.status, 502, 'errorStatus applies after latency');
  assert.ok(elapsed >= 110, 'latency also applied');

  // stop only errorStatus; latency must remain
  await api('/chaos/faults/errorStatus/stop', 'POST');
  const t1 = performance.now();
  const res2 = await fetch(base + '/api/hello');
  assert.ok(performance.now() - t1 >= 110);
  assert.equal(res2.status, 200);

  await api('/chaos/stop-all', 'POST');
  const status2 = await api('/chaos/status');
  assert.equal(status2.json.active.length, 0);
  const t2 = performance.now();
  const res3 = await fetch(base + '/api/hello');
  assert.ok(performance.now() - t2 < 100, 'fully recovered after stop-all');
  assert.equal(res3.status, 200);
  assert.ok(json.started.sessionId);
});

test('probabilistic injection: ~50% of requests affected, history matches', async () => {
  const { json } = await api('/chaos/faults/errorStatus/start', 'POST', { probability: 0.5, params: { statusCode: 500 } });
  const sessionId = json.started.sessionId as string;
  const N = 200;
  let injected = 0;
  for (let i = 0; i < N; i++) {
    const res = await fetch(base + '/api/hello');
    if (res.status === 500) injected++;
    else await res.text();
  }
  const rate = injected / N;
  assert.ok(rate > 0.35 && rate < 0.65, `injection rate ${rate} outside [0.35, 0.65]`);
  await api('/chaos/faults/errorStatus/stop', 'POST');
  const stats = await api(`/chaos/sessions/${sessionId}`);
  assert.equal(stats.json.affectedRequests, injected, 'sqlite count must equal observed injected count');
});

test('error semantics: bad input, conflicts, unknown session are distinct', async () => {
  const bad = await api('/chaos/faults/latency/start', 'POST', { probability: 2 });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'INVALID_CONFIG');

  const nope = await api('/chaos/faults/latency/stop', 'POST');
  assert.equal(nope.status, 409);
  assert.equal(nope.json.error.code, 'FAULT_NOT_ACTIVE');

  const ghost = await api('/chaos/sessions/does-not-exist');
  assert.equal(ghost.status, 404);
  assert.equal(ghost.json.error.code, 'NOT_FOUND');

  const badType = await api('/chaos/faults/explode/start', 'POST', {});
  assert.equal(badType.status, 400);
});
