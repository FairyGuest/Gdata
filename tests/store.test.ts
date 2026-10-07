import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrchestratorStore } from '../src/store/db.ts';
import { loadFixture } from './helpers.ts';

test('definitions and computations are versioned and queryable', () => {
  const store = new OrchestratorStore(':memory:');
  const def = loadFixture();
  const v1 = store.createOrchestration(def.name, def);
  assert.equal(v1, 1);
  const changed = { ...def, services: def.services.map((s) => (s.name === 'postgres' ? { ...s, ports: [5433] } : s)) };
  const v2 = store.addVersion(def.name, changed);
  assert.equal(v2, 2);
  assert.deepEqual(store.listVersions(def.name), [1, 2]);

  store.saveComputation(def.name, 1, 'plan', 'run-v1', { startOrder: ['postgres', 'redis', 'api', 'worker', 'gateway'] });
  store.saveComputation(def.name, 2, 'plan', 'run-v2', { startOrder: ['redis', 'postgres', 'api', 'worker', 'gateway'] });

  const q1 = store.getComputation(def.name, 1, 'plan');
  const q2 = store.getComputation(def.name, 2, 'plan');
  assert.equal(q1?.runId, 'run-v1');
  assert.equal(q2?.runId, 'run-v2');
  assert.deepEqual((q1?.result as { startOrder: string[] }).startOrder[0], 'postgres');
  assert.deepEqual((q2?.result as { startOrder: string[] }).startOrder[0], 'redis');

  const latest = store.getDefinition(def.name);
  assert.equal(latest?.version, 2);
  const first = store.getDefinition(def.name, 1);
  assert.equal(first?.version, 1);
  assert.deepEqual(first?.definition.services.find((s) => s.name === 'postgres')?.ports, [5432]);
  store.close();
});

test('run logs round-trip with ordering preserved', () => {
  const store = new OrchestratorStore(':memory:');
  store.appendLog({ runId: 'r1', seq: 1, level: 'info', event: 'a', data: { x: 1 } });
  store.appendLog({ runId: 'r1', seq: 2, level: 'error', event: 'b', data: { reason: 'boom' } });
  const logs = store.getLogs('r1');
  assert.equal(logs.length, 2);
  assert.deepEqual(logs.map((l) => l.event), ['a', 'b']);
  assert.equal(logs[1].level, 'error');
  store.close();
});
