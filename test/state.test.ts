// State lifecycle tests: manual start/stop, auto-stop, conflict errors, sqlite history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChaosStore } from '../src/store.ts';
import { FaultManager } from '../src/state.ts';
import { ChaosError } from '../src/contracts.ts';

const mgr = () => new FaultManager(new ChaosStore(':memory:'), 'test-run');

test('start/stop lifecycle recorded in sqlite', () => {
  const m = mgr();
  const f = m.start('latency', { probability: 1, params: { delayMs: 10 } });
  assert.equal(m.list().length, 1);
  m.record({ sessionId: f.sessionId, requestId: 'req-1', faultType: 'latency', durationMs: 10, detail: 'delay 10ms' });
  m.record({ sessionId: f.sessionId, requestId: 'req-2', faultType: 'latency', durationMs: 11, detail: 'delay 10ms' });
  m.stop('latency');
  assert.equal(m.list().length, 0);
  const stats = m.sessionStats(f.sessionId);
  assert.equal(stats.affectedRequests, 2);
  assert.ok(stats.session.ended_at, 'session must have ended_at after stop');
  assert.equal(stats.events.length, 2);
  assert.ok(stats.events[0].timestamp);
});

test('double start conflicts with FAULT_ALREADY_ACTIVE', () => {
  const m = mgr();
  m.start('abort', {});
  assert.throws(() => m.start('abort', {}),
    (e: unknown) => e instanceof ChaosError && e.code === 'FAULT_ALREADY_ACTIVE');
});

test('stop of inactive fault fails with FAULT_NOT_ACTIVE', () => {
  const m = mgr();
  assert.throws(() => m.stop('abort'),
    (e: unknown) => e instanceof ChaosError && e.code === 'FAULT_NOT_ACTIVE');
});

test('auto-stop after durationMs', async () => {
  const m = mgr();
  m.start('truncate', { durationMs: 60 });
  assert.equal(m.list().length, 1);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(m.list().length, 0, 'fault must auto-stop');
});

test('unknown session id -> NOT_FOUND', () => {
  const m = mgr();
  assert.throws(() => m.sessionStats('nope'),
    (e: unknown) => e instanceof ChaosError && e.code === 'NOT_FOUND');
});
