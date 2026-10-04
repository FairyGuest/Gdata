import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, satisfiesRange, parseVersion } from '../src/core/semver.ts';
import { ScanError } from '../src/contract/errors.ts';

test('compareVersions compares numerically, not lexicographically', () => {
  // String order would say "1.10.0" < "1.9.0"; semver says the opposite.
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('0.0.9', '0.0.10'), -1);
});

test('parseVersion rejects non-semver input as INPUT_ERROR', () => {
  assert.throws(() => parseVersion('1.2'), (e) => e instanceof ScanError && e.category === 'INPUT_ERROR');
  assert.throws(() => parseVersion('v1.2.3'), (e) => e instanceof ScanError && e.category === 'INPUT_ERROR');
});

test('satisfiesRange: inclusive boundary is included', () => {
  assert.equal(satisfiesRange('1.2.0', '>=1.0.0 <=1.2.0'), true);  // exactly on upper bound
  assert.equal(satisfiesRange('1.0.0', '>=1.0.0 <=1.2.0'), true);  // exactly on lower bound
});

test('satisfiesRange: value just outside boundary is excluded', () => {
  assert.equal(satisfiesRange('1.2.1', '>=1.0.0 <=1.2.0'), false); // one patch above
  assert.equal(satisfiesRange('0.9.9', '>=1.0.0 <=1.2.0'), false);  // one patch below
  assert.equal(satisfiesRange('2.0.0', '<2.0.0'), false);           // exclusive upper bound
  assert.equal(satisfiesRange('1.9.9', '<2.0.0'), true);
});

test('satisfiesRange: caret, tilde, wildcard, exact', () => {
  assert.equal(satisfiesRange('1.4.2', '^1.2.0'), true);
  assert.equal(satisfiesRange('2.0.0', '^1.2.0'), false);
  assert.equal(satisfiesRange('1.2.9', '~1.2.0'), true);
  assert.equal(satisfiesRange('1.3.0', '~1.2.0'), false);
  assert.equal(satisfiesRange('9.9.9', '*'), true);
  assert.equal(satisfiesRange('1.2.3', '1.2.3'), true);
  assert.equal(satisfiesRange('1.2.4', '1.2.3'), false);
});

test('satisfiesRange: invalid comparator raises INPUT_ERROR', () => {
  assert.throws(() => satisfiesRange('1.0.0', '=>1.0.0'), (e) => e instanceof ScanError && e.category === 'INPUT_ERROR');
});
