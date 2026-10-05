import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchema } from '../src/contract/schema.ts';
import { FactoryError } from '../src/contract/errors.ts';
import { generateDataset } from '../src/kernel/generate.ts';
import { TEST_LIMITS } from './helpers.ts';

function expectFactoryError(fn: () => unknown, category: string, messagePart?: string): FactoryError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof FactoryError, 'expected FactoryError, got: ' + String(e));
    assert.equal(e.category, category, 'wrong error category');
    if (messagePart) assert.ok(e.message.includes(messagePart), 'message missing "' + messagePart + '": ' + e.message);
    return e;
  }
  assert.fail('expected FactoryError(' + category + ') but nothing was thrown');
}

test('integer min > max is rejected as INPUT_ERROR', () => {
  expectFactoryError(
    () => parseSchema({ fields: { n: { kind: 'integer', min: 10, max: 1 } } }, TEST_LIMITS),
    'INPUT_ERROR',
    'constraint conflict',
  );
});

test('string minLength > maxLength is rejected as INPUT_ERROR', () => {
  expectFactoryError(
    () => parseSchema({ fields: { s: { kind: 'string', minLength: 9, maxLength: 2 } } }, TEST_LIMITS),
    'INPUT_ERROR',
    'minLength (9) > maxLength (2)',
  );
});

test('date min after max is rejected as INPUT_ERROR', () => {
  expectFactoryError(
    () => parseSchema({ fields: { d: { kind: 'date', min: '2025-01-01', max: '2020-01-01' } } }, TEST_LIMITS),
    'INPUT_ERROR',
    'constraint conflict',
  );
});

test('array minItems > maxItems is rejected as INPUT_ERROR', () => {
  expectFactoryError(
    () => parseSchema({ fields: { a: { kind: 'array', minItems: 5, maxItems: 2, items: { kind: 'integer' } } } }, TEST_LIMITS),
    'INPUT_ERROR',
    'minItems (5) > maxItems (2)',
  );
});

test('empty enum values are rejected as INPUT_ERROR', () => {
  expectFactoryError(
    () => parseSchema({ fields: { e: { kind: 'enum', values: [] } } }, TEST_LIMITS),
    'INPUT_ERROR',
    'non-empty',
  );
});

test('invalid regex pattern is rejected as INPUT_ERROR', () => {
  expectFactoryError(
    () => parseSchema({ fields: { s: { kind: 'string', pattern: '([' } } }, TEST_LIMITS),
    'INPUT_ERROR',
    'not a valid regex',
  );
});

test('unknown field kind is rejected as INPUT_ERROR', () => {
  expectFactoryError(
    () => parseSchema({ fields: { x: { kind: 'float' } } }, TEST_LIMITS),
    'INPUT_ERROR',
    'unknown kind',
  );
});

test('count above maxCount is RESOURCE_EXHAUSTED', () => {
  const schema = parseSchema({ fields: { n: { kind: 'integer' } } }, TEST_LIMITS);
  expectFactoryError(
    () => generateDataset(schema, 1, TEST_LIMITS.maxCount + 1, TEST_LIMITS),
    'RESOURCE_EXHAUSTED',
    'maxCount',
  );
});

test('array maxItems above limit is RESOURCE_EXHAUSTED', () => {
  expectFactoryError(
    () => parseSchema({ fields: { a: { kind: 'array', maxItems: TEST_LIMITS.maxArrayItems + 1, items: { kind: 'integer' } } } }, TEST_LIMITS),
    'RESOURCE_EXHAUSTED',
    'maxArrayItems',
  );
});

test('unsatisfiable pattern exhausts attempts and fails as COMPUTE_FAILURE', () => {
  const schema = parseSchema(
    { fields: { s: { kind: 'string', minLength: 1, maxLength: 2, charset: 'ab', pattern: '^z{5}$' } } },
    TEST_LIMITS,
  );
  const err = expectFactoryError(() => generateDataset(schema, 1, 1, TEST_LIMITS), 'COMPUTE_FAILURE', 'attempts');
  assert.ok(String((err.details as Record<string, unknown>).pattern).includes('z{5}'));
});

test('error path identifies the offending field', () => {
  const err = expectFactoryError(
    () => parseSchema({ fields: { ok: { kind: 'integer' }, bad: { kind: 'integer', min: 5, max: 4 } } }, TEST_LIMITS),
    'INPUT_ERROR',
  );
  assert.ok(err.message.startsWith('fields.bad:'), 'path missing: ' + err.message);
});
