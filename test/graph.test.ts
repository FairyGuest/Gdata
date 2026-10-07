import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, computeAffected, topoOrder } from '../src/core/graph.ts';

const defs = [
  { name: 'lib', paths: ['src/lib.ts'], deps: [] },
  { name: 'app', paths: ['src/app.ts'], deps: ['lib'] },
  { name: 'docs', paths: ['docs/readme.md'], deps: [] },
  { name: 'extra', paths: ['src/extra.ts'], deps: ['lib', 'docs'] },
];

test('computeAffected: direct hit plus transitive closure downstream', () => {
  const graph = buildGraph(defs);
  const { direct, affected } = computeAffected(graph, ['src/lib.ts']);
  assert.deepEqual(direct, ['lib']);
  assert.deepEqual(affected, ['app', 'extra', 'lib']);
});

test('computeAffected: unrelated change affects only its own target', () => {
  const graph = buildGraph(defs);
  const { direct, affected } = computeAffected(graph, ['docs/readme.md']);
  assert.deepEqual(direct, ['docs']);
  assert.deepEqual(affected, ['docs', 'extra']);
});

test('computeAffected: unknown path affects nothing', () => {
  const graph = buildGraph(defs);
  const { direct, affected } = computeAffected(graph, ['src/nope.ts']);
  assert.deepEqual(direct, []);
  assert.deepEqual(affected, []);
});

test('topoOrder: dependencies first, lexicographic tie-break', () => {
  const graph = buildGraph(defs);
  assert.deepEqual(topoOrder(graph, ['lib', 'app', 'extra']), ['lib', 'app', 'extra']);
  // diamond: b and c both depend on a, d depends on both
  const diamond = buildGraph([
    { name: 'd', paths: ['d'], deps: ['b', 'c'] },
    { name: 'b', paths: ['b'], deps: ['a'] },
    { name: 'c', paths: ['c'], deps: ['a'] },
    { name: 'a', paths: ['a'], deps: [] },
  ]);
  assert.deepEqual(topoOrder(diamond, ['a', 'b', 'c', 'd']), ['a', 'b', 'c', 'd']);
});

test('buildGraph rejects unknown deps and cycles with distinct error codes', () => {
  assert.throws(
    () => buildGraph([{ name: 'a', paths: ['a'], deps: ['ghost'] }]),
    (err: unknown) => (err as { code?: string }).code === 'INPUT_ERROR',
  );
  assert.throws(
    () => buildGraph([
      { name: 'a', paths: ['a'], deps: ['b'] },
      { name: 'b', paths: ['b'], deps: ['a'] },
    ]),
    (err: unknown) => (err as { code?: string }).code === 'COMPUTATION_ERROR',
  );
});