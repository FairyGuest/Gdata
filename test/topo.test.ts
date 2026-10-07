import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSpec } from '../src/contract/parse.ts';
import { validateSpec } from '../src/core/validate.ts';
import { layeredTopoSort } from '../src/core/topo.ts';

const spec = parseSpec(JSON.parse(readFileSync(new URL('../fixtures/valid-multi-layer.json', import.meta.url), 'utf8')));

test('layered topo sort: dependencies first, lexicographic within a layer', () => {
  validateSpec(spec);
  const plan = layeredTopoSort(spec);
  assert.deepEqual(plan.layers, [['cache', 'db'], ['api', 'worker'], ['gateway']]);
  assert.deepEqual(plan.startOrder, ['cache', 'db', 'api', 'worker', 'gateway']);
});

test('stop order is the strict reverse of start order', () => {
  const plan = layeredTopoSort(spec);
  assert.deepEqual(plan.stopOrder, ['gateway', 'worker', 'api', 'db', 'cache']);
  assert.deepEqual(plan.stopOrder, [...plan.startOrder].reverse());
});

test('output is stable across repeated computations', () => {
  const a = layeredTopoSort(spec);
  const b = layeredTopoSort(spec);
  assert.deepEqual(a, b);
});
