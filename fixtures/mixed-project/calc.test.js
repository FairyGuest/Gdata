import test from 'node:test';
import assert from 'node:assert/strict';
import { add, isSame, track } from './src/calc.js';

test('add sums', () => {
  assert.equal(add(2, 3), 5);
});

test('isSame compares strictly', () => {
  assert.equal(isSame(2, 2), true);
  assert.equal(isSame(2, 3), false);
});

test('track returns the value untouched', () => {
  assert.equal(track(7), 7);
});
