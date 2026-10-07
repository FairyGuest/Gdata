import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSpec } from '../src/contract/parse.ts';
import { validateSpec } from '../src/core/validate.ts';
import { layeredTopoSort } from '../src/core/topo.ts';
import { simulateStartup } from '../src/core/health.ts';

const load = (name: string) =>
  parseSpec(JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')));

test('all-healthy graph advances layer by layer to completion', () => {
  const spec = load('valid-multi-layer.json');
  validateSpec(spec);
  const plan = layeredTopoSort(spec);
  const logs: string[] = [];
  const result = simulateStartup(spec, plan.layers, (l) => logs.push(l));
  assert.equal(result.status, 'completed');
  assert.equal(result.layers.length, 3);
  assert.ok(result.layers.every((l) => l.services.every((s) => s.status === 'healthy')));
  assert.ok(logs.some((l) => l.includes('layer 0: all healthy')));
});

test('failing fixture halts the batch at that layer with failure location', () => {
  const spec = load('failing-health.json');
  validateSpec(spec);
  const plan = layeredTopoSort(spec);
  assert.deepEqual(plan.layers, [['db'], ['api', 'worker'], ['gateway']]);
  const logs: string[] = [];
  const result = simulateStartup(spec, plan.layers, (l) => logs.push(l));
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.failure?.layer, 1);
  assert.deepEqual(result.failure?.services, ['api']);
  const gateway = result.layers[2].services.find((s) => s.name === 'gateway');
  assert.equal(gateway?.status, 'blocked');
  const worker = result.layers[1].services.find((s) => s.name === 'worker');
  assert.equal(worker?.status, 'healthy');
  assert.ok(logs.some((l) => l.includes('batch halted')));
});
