import test from 'node:test';
import assert from 'node:assert/strict';
import { countTo } from './src/counter.js';

test('countTo counts up', () => {
  assert.equal(countTo(3), 3);
});
