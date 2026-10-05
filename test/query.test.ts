import test from 'node:test';
import assert from 'node:assert/strict';
import { filterSortCases, parseCaseQuery } from '../src/kernel/query.js';
import type { TestCase } from '../src/contract/types.js';

function tc(file: string, name: string, status: TestCase['status'], durationMs: number): TestCase {
  return { key: file + '::' + name, file, name, status, durationMs, runId: 'r1' };
}

const cases: TestCase[] = [
  tc('b/login.test.ts', 'logs in', 'passed', 30),
  tc('a/cart.test.ts', 'adds item', 'failed', 10),
  tc('a/cart.test.ts', 'empties cart', 'skipped', 50),
  tc('c/pay.test.ts', 'pays', 'failed', 20),
];

test('parseCaseQuery defaults and validation', () => {
  assert.deepEqual(parseCaseQuery({}), { sort: 'file', order: 'asc' });
  assert.throws(() => parseCaseQuery({ status: 'bogus' }), /invalid status filter/);
  assert.throws(() => parseCaseQuery({ sort: 'bogus' }), /invalid sort field/);
  assert.throws(() => parseCaseQuery({ order: 'sideways' }), /invalid order/);
});

test('filterSortCases filters by status, file, and name', () => {
  const failed = filterSortCases(cases, parseCaseQuery({ status: 'failed' }));
  assert.deepEqual(failed.map((c) => c.key), ['a/cart.test.ts::adds item', 'c/pay.test.ts::pays']);

  const byFile = filterSortCases(cases, parseCaseQuery({ file: 'cart' }));
  assert.equal(byFile.length, 2);

  const byName = filterSortCases(cases, parseCaseQuery({ name: 'CART' }));
  assert.deepEqual(byName.map((c) => c.key), ['a/cart.test.ts::empties cart']);

  const combined = filterSortCases(cases, parseCaseQuery({ status: 'failed', file: 'pay' }));
  assert.deepEqual(combined.map((c) => c.key), ['c/pay.test.ts::pays']);
});

test('filterSortCases sorts by each dimension in both orders', () => {
  const byDurationDesc = filterSortCases(cases, parseCaseQuery({ sort: 'durationMs', order: 'desc' }));
  assert.deepEqual(byDurationDesc.map((c) => c.durationMs), [50, 30, 20, 10]);

  const byName = filterSortCases(cases, parseCaseQuery({ sort: 'name', order: 'asc' }));
  assert.deepEqual(byName.map((c) => c.name), ['adds item', 'empties cart', 'logs in', 'pays']);

  const byStatus = filterSortCases(cases, parseCaseQuery({ sort: 'status', order: 'asc' }));
  assert.deepEqual(byStatus.map((c) => c.status), ['failed', 'failed', 'passed', 'skipped']);
});

