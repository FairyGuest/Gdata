import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, isPositive } from '../src/calc.js';

test('add sums two numbers', () => {
  assert.equal(add(2, 3), 5);
});

test('isPositive treats zero as not positive', () => {
  assert.equal(isPositive(0), false);
  assert.equal(isPositive(1), true);
});

