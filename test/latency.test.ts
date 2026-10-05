import test from 'node:test';
import assert from 'node:assert/strict';
import { httpRequest, logStep, startChaos, startInjection, stopChaos } from './helpers';

test('latency injection adds measurable delay and stops cleanly', async (t) => {
  const ctx = await startChaos();
  t.after(() => stopChaos(ctx));

  const baseline = await httpRequest(ctx.base + '/');
  assert.equal(baseline.status, 200);
  logStep('latency', 'baseline', { elapsedMs: baseline.elapsedMs }, 'target healthy before injection');

  const delayMs = 150;
  const started = await startInjection(ctx.base, {
    faultType: 'latency',
    probability: 1,
    params: { delayMs },
  });
  assert.equal(started.status, 201);
  const sessionId = (started.json.injection as { id: string }).id;

  const injected = await httpRequest(ctx.base + '/');
  logStep('latency', 'injected request', { elapsedMs: injected.elapsedMs, delayMs },
    'elapsed must be >= injected delay');
  assert.ok(injected.elapsedMs >= delayMs - 10, 'expected >= ' + (delayMs - 10) + 'ms, got ' + injected.elapsedMs + 'ms');
  assert.ok(injected.elapsedMs < delayMs + 1000, 'delay wildly exceeded: ' + injected.elapsedMs + 'ms');
  assert.equal(injected.status, 200);

  await httpRequest(ctx.base + '/chaos/injections/' + sessionId + '/stop', { method: 'POST' });
  const recovered = await httpRequest(ctx.base + '/');
  logStep('latency', 'recovered request', { elapsedMs: recovered.elapsedMs },
    'after stop, latency must return to baseline');
  assert.equal(recovered.status, 200);
  assert.ok(recovered.elapsedMs < delayMs, 'still slow after stop: ' + recovered.elapsedMs + 'ms');
});

test('latency injection auto-stops after durationMs', async (t) => {
  const ctx = await startChaos();
  t.after(() => stopChaos(ctx));

  const started = await startInjection(ctx.base, {
    faultType: 'latency',
    probability: 1,
    durationMs: 200,
    params: { delayMs: 300 },
  });
  assert.equal(started.status, 201);
  const sessionId = (started.json.injection as { id: string }).id;

  const during = await httpRequest(ctx.base + '/');
  assert.ok(during.elapsedMs >= 290, 'expected injected delay, got ' + during.elapsedMs + 'ms');

  await new Promise((r) => setTimeout(r, 350));
  const after = await httpRequest(ctx.base + '/');
  const session = await httpRequest(ctx.base + '/chaos/injections/' + sessionId);
  const status = (JSON.parse(session.body).injection as { status: string }).status;
  logStep('latency', 'auto-stop', { elapsedMs: after.elapsedMs, sessionStatus: status },
    'durationMs elapsed -> session expired, delay gone');
  assert.equal(status, 'expired');
  assert.ok(after.elapsedMs < 300, 'delay persisted after expiry: ' + after.elapsedMs + 'ms');
});