import { test } from 'node:test';
import assert from 'node:assert/strict';
import { impactClosure } from '../src/domain/impact.ts';
import { DomainError } from '../src/domain/errors.ts';
import { loadFixture } from './helpers.ts';

test('changing a base service affects its transitive dependents only', () => {
  const impact = impactClosure(loadFixture(), 'postgres');
  assert.deepEqual(impact.affected, ['api', 'gateway', 'postgres', 'worker']);
  assert.deepEqual(impact.skipped, ['redis']);
});

test('changing a leaf service affects only itself', () => {
  const impact = impactClosure(loadFixture(), 'gateway');
  assert.deepEqual(impact.affected, ['gateway']);
  assert.deepEqual(impact.skipped, ['api', 'postgres', 'redis', 'worker']);
});

test('changing redis skips postgres and worker', () => {
  const impact = impactClosure(loadFixture(), 'redis');
  assert.deepEqual(impact.affected, ['api', 'gateway', 'redis']);
  assert.deepEqual(impact.skipped, ['postgres', 'worker']);
});

test('unknown service is a NOT_FOUND error', () => {
  assert.throws(() => impactClosure(loadFixture(), 'ghost'), (err: unknown) => {
    assert.ok(err instanceof DomainError);
    assert.equal(err.category, 'NOT_FOUND');
    return true;
  });
});
