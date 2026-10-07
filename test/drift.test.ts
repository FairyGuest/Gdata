import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareDrift } from '../src/core/drift.ts';

test('drift classifies missing, mismatch and extra with dot paths', () => {
  const effective = {
    service: { port: 9090, name: 'checkout' },
    limits: { cpu: '1000m', memory: '256Mi' },
  };
  const snapshot = {
    service: { port: 8080, name: 'checkout' },
    limits: { cpu: '1000m' },
    runtime: { node: 'v24' },
  };
  const report = compareDrift(effective, snapshot);
  assert.equal(report.status, 'drifted');
  assert.deepEqual(report.counts, { missing: 1, mismatch: 1, extra: 1 });
  // severity order: missing first, then mismatch, then extra
  assert.deepEqual(
    report.items.map((i) => [i.category, i.path]),
    [
      ['missing', 'limits.memory'],
      ['mismatch', 'service.port'],
      ['extra', 'runtime.node'],
    ],
  );
  assert.equal(report.items[1].expected, 9090);
  assert.equal(report.items[1].actual, 8080);
});

test('drift sorts lexicographically within the same category', () => {
  const effective = { b: 1, a: 1, c: 1 };
  const snapshot = { b: 2, a: 2, c: 2 };
  const report = compareDrift(effective, snapshot);
  assert.deepEqual(report.items.map((i) => i.path), ['a', 'b', 'c']);
});

test('no drift returns explicit pass marker', () => {
  const effective = { a: { b: [1, 2] }, c: 'x' };
  const snapshot = { a: { b: [1, 2] }, c: 'x' };
  const report = compareDrift(effective, snapshot);
  assert.equal(report.status, 'pass');
  assert.deepEqual(report.items, []);
  assert.deepEqual(report.counts, { missing: 0, mismatch: 0, extra: 0 });
});

test('array value difference is a mismatch at the array path', () => {
  const report = compareDrift({ tags: ['a', 'b'] }, { tags: ['a', 'c'] });
  assert.deepEqual(report.items.map((i) => [i.category, i.path]), [['mismatch', 'tags']]);
});

test('type change between object and scalar is a mismatch, not recursion', () => {
  const report = compareDrift({ a: { b: 1 } }, { a: 5 });
  assert.deepEqual(report.items.map((i) => [i.category, i.path]), [['mismatch', 'a']]);
});
