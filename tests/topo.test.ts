import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayers, computePlan } from '../src/domain/topo.ts';
import { loadFixture, svc } from './helpers.ts';

test('layers group independent services and sort siblings lexicographically', () => {
  const def = loadFixture();
  assert.deepEqual(computeLayers(def), [['postgres', 'redis'], ['api', 'worker'], ['gateway']]);
});

test('start order is dependency-first and stable regardless of input order', () => {
  const def = loadFixture();
  const plan = computePlan(def);
  assert.deepEqual(plan.startOrder, ['postgres', 'redis', 'api', 'worker', 'gateway']);
  const shuffled = { ...def, services: [...def.services].reverse() };
  assert.deepEqual(computePlan(shuffled).startOrder, plan.startOrder);
});

test('stop order is the exact reverse of start order', () => {
  const plan = computePlan(loadFixture());
  assert.deepEqual(plan.stopOrder, ['gateway', 'worker', 'api', 'redis', 'postgres']);
});

test('diamond dependencies land in expected layers', () => {
  const def = {
    name: 'diamond',
    services: [
      svc({ name: 'a' }),
      svc({ name: 'b', dependsOn: ['a'] }),
      svc({ name: 'c', dependsOn: ['a'] }),
      svc({ name: 'd', dependsOn: ['b', 'c'] }),
    ],
  };
  assert.deepEqual(computeLayers(def), [['a'], ['b', 'c'], ['d']]);
});
