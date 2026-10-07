import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSpec } from '../src/contract/parse.ts';
import { OrchestrationError } from '../src/contract/errors.ts';
import { affectedClosure } from '../src/core/impact.ts';

const spec = parseSpec(
  JSON.parse(readFileSync(new URL('../fixtures/valid-multi-layer.json', import.meta.url), 'utf8')),
);

test('changing a base service marks its transitive dependents, skips the rest', () => {
  const impact = affectedClosure(spec, 'db');
  assert.deepEqual(impact.affected, ['api', 'db', 'gateway', 'worker']);
  assert.deepEqual(impact.skipped, ['cache']);
});

test('changing a mid-layer service only affects its dependents', () => {
  const impact = affectedClosure(spec, 'cache');
  assert.deepEqual(impact.affected, ['api', 'cache', 'gateway']);
  assert.deepEqual(impact.skipped, ['db', 'worker']);
});

test('changing a leaf service affects only itself', () => {
  const impact = affectedClosure(spec, 'gateway');
  assert.deepEqual(impact.affected, ['gateway']);
  assert.deepEqual(impact.skipped, ['api', 'cache', 'db', 'worker']);
});

test('unknown changed service is a NOT_FOUND error', () => {
  assert.throws(
    () => affectedClosure(spec, 'nope'),
    (err: unknown) => err instanceof OrchestrationError && err.code === 'NOT_FOUND',
  );
});
