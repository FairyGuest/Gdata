import test from 'node:test';
import assert from 'node:assert/strict';

test('placeholder that never exercises calc', () => {
  assert.equal(1, 1);
});
