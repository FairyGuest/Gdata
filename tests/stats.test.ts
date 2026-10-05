import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, percentile } from '../src/stats.ts';

// Reference values below are hand-computed with the nearest-rank method:
// rank = ceil(p/100 * n), value = sorted[rank-1]. They are written as
// literals here, NOT derived from the implementation under test.

test('percentile boundaries on n=10 sample', () => {
  const s = summarize([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(s.count, 10);
  assert.equal(s.min, 10);
  assert.equal(s.max, 100);
  assert.equal(s.mean, 55);
  assert.equal(s.p50, 50); // rank ceil(5.0)=5 -> 5th value
  assert.equal(s.p90, 90); // rank ceil(9.0)=9
  assert.equal(s.p95, 100); // rank ceil(9.5)=10
  assert.equal(s.p99, 100); // rank ceil(9.9)=10
});

test('percentile boundaries on n=100 sample (1..100)', () => {
  const data = Array.from({ length: 100 }, (_, i) => i + 1);
  const s = summarize(data);
  assert.equal(s.p50, 50);
  assert.equal(s.p90, 90);
  assert.equal(s.p95, 95);
  assert.equal(s.p99, 99);
  assert.equal(s.mean, 50.5);
});

test('unsorted input and duplicates', () => {
  const s = summarize([10, 5, 5, 5]);
  assert.equal(s.count, 4);
  assert.equal(s.min, 5);
  assert.equal(s.max, 10);
  assert.equal(s.mean, 6.25);
  assert.equal(s.p50, 5); // rank ceil(2.0)=2 -> sorted[1]=5
  assert.equal(s.p99, 10); // rank ceil(3.96)=4 -> sorted[3]=10
});

test('empty and single-element samples', () => {
  const empty = summarize([]);
  assert.equal(empty.count, 0);
  assert.equal(empty.p50, 0);
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([5], 99), 5);
  assert.equal(percentile([5], 1), 5);
});
