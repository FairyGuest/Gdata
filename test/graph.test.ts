import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGraph } from '../src/core/graph.ts';
import { ScanError } from '../src/contract/errors.ts';

const LIMITS = { maxPackages: 100, maxDepth: 10 };

function pkg(name, version, dependencies = {}) {
  return { name, version, dependencies };
}

test('resolves full transitive closure with correct depth and paths', () => {
  const packages = [
    pkg('app', '1.0.0', { a: '1.0.0' }),
    pkg('a', '1.0.0', { b: '1.0.0' }),
    pkg('b', '1.0.0', { c: '1.0.0' }),
    pkg('c', '1.0.0', { d: '1.0.0' }),
    pkg('d', '1.0.0'),
  ];
  const g = resolveGraph(packages, 'app@1.0.0', LIMITS);
  assert.equal(g.nodes.size, 5);
  assert.equal(g.maxDepthReached, 4);
  assert.deepEqual(g.paths.get('d@1.0.0'),
    ['app@1.0.0', 'a@1.0.0', 'b@1.0.0', 'c@1.0.0', 'd@1.0.0']);
  assert.deepEqual(g.cycles, []);
});

test('cycle edges are recorded but not expanded (no infinite loop)', () => {
  const packages = [
    pkg('app', '1.0.0', { x: '1.0.0' }),
    pkg('x', '1.0.0', { y: '1.0.0' }),
    pkg('y', '1.0.0', { x: '1.0.0' }), // y -> x closes a cycle
  ];
  const g = resolveGraph(packages, 'app@1.0.0', LIMITS);
  assert.equal(g.nodes.size, 3); // terminates
  assert.deepEqual(g.cycles, [{ from: 'y@1.0.0', to: 'x@1.0.0' }]);
  assert.equal(g.nodes.get('x@1.0.0').dependencies.length, 1);
});

test('self-dependency is a recorded cycle', () => {
  const packages = [pkg('app', '1.0.0', { app: '1.0.0' })];
  const g = resolveGraph(packages, 'app@1.0.0', LIMITS);
  assert.equal(g.nodes.size, 1);
  assert.deepEqual(g.cycles, [{ from: 'app@1.0.0', to: 'app@1.0.0' }]);
});

test('exceeding maxDepth fails as RESOURCE_EXHAUSTED', () => {
  const packages = [
    pkg('app', '1.0.0', { a: '1.0.0' }),
    pkg('a', '1.0.0', { b: '1.0.0' }),
    pkg('b', '1.0.0', { c: '1.0.0' }),
    pkg('c', '1.0.0'),
  ];
  assert.throws(
    () => resolveGraph(packages, 'app@1.0.0', { maxPackages: 100, maxDepth: 2 }),
    (e) => e instanceof ScanError && e.category === 'RESOURCE_EXHAUSTED');
});

test('exceeding maxPackages fails as RESOURCE_EXHAUSTED', () => {
  const packages = [pkg('app', '1.0.0', { a: '1.0.0', b: '1.0.0' }), pkg('a', '1.0.0'), pkg('b', '1.0.0')];
  assert.throws(
    () => resolveGraph(packages, 'app@1.0.0', { maxPackages: 2, maxDepth: 10 }),
    (e) => e instanceof ScanError && e.category === 'RESOURCE_EXHAUSTED');
});

test('referencing a missing package fails as INPUT_ERROR', () => {
  const packages = [pkg('app', '1.0.0', { ghost: '1.0.0' })];
  assert.throws(
    () => resolveGraph(packages, 'app@1.0.0', LIMITS),
    (e) => e instanceof ScanError && e.category === 'INPUT_ERROR');
});
