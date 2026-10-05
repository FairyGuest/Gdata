import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './src/calc.js';

test('deliberately wrong expectation', () => {
  assert.equal(add(2, 3), 6);
});
