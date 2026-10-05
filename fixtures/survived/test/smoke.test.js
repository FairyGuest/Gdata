import { test } from 'node:test';
import assert from 'node:assert/strict';

test('smoke test does not exercise multiply', () => {
  assert.equal(1 + 1, 2);
});

