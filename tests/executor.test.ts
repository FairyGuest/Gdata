import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeStart } from '../src/kernel/executor.ts';
import { RunLogger } from '../src/kernel/logger.ts';
import { OrchestratorStore } from '../src/store/db.ts';
import { loadFixture } from './helpers.ts';
import type { OrchestrationDef } from '../src/domain/types.ts';

function withUnhealthy(def: OrchestrationDef, serviceName: string): OrchestrationDef {
  return {
    ...def,
    services: def.services.map((s) =>
      s.name === serviceName ? { ...s, health: { kind: 'fixture', fixture: 'unhealthy', detail: 'probe timeout (synthetic)' } } : s,
    ),
  };
}

function makeLogger(): { logger: RunLogger; store: OrchestratorStore } {
  const store = new OrchestratorStore(':memory:');
  return { logger: new RunLogger(store, 'test-run-1'), store };
}

test('all-healthy stack executes every layer in order', () => {
  const { logger } = makeLogger();
  const result = executeStart(loadFixture(), logger);
  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(result.startedServices, ['postgres', 'redis', 'api', 'worker', 'gateway']);
  assert.deepEqual(result.completedLayers, [['postgres', 'redis'], ['api', 'worker'], ['gateway']]);
});

test('unhealthy service halts the batch at its layer with failure location', () => {
  const { logger } = makeLogger();
  const result = executeStart(withUnhealthy(loadFixture(), 'api'), logger);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.failedLayer, 1);
  assert.deepEqual(result.failures, [{ service: 'api', reason: 'fixture reports unhealthy: probe timeout (synthetic)' }]);
  assert.deepEqual(result.startedServices, ['postgres', 'redis']);
  assert.deepEqual(result.completedLayers, [['postgres', 'redis']]);
});

test('execution logs capture run id, intermediate states and reasons', () => {
  const { logger, store } = makeLogger();
  executeStart(withUnhealthy(loadFixture(), 'api'), logger);
  const logs = store.getLogs('test-run-1');
  assert.ok(logs.length > 0);
  assert.ok(logs.every((l) => l.runId === 'test-run-1'));
  assert.deepEqual(logs.map((l) => l.seq), logs.map((_, i) => i + 1));
  const failed = logs.find((l) => l.event === 'layer.failed');
  assert.ok(failed, 'expected a layer.failed log entry');
  assert.equal((failed.data as { layer: number }).layer, 1);
  store.close();
});
