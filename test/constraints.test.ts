import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDataset } from '../src/kernel/generate.ts';
import { parseSchema } from '../src/contract/schema.ts';
import { TEST_LIMITS } from './helpers.ts';

test('integer values always stay inside [min, max]', () => {
  const schema = parseSchema({ fields: { n: { kind: 'integer', min: -5, max: 7 } } }, TEST_LIMITS);
  const { rows } = generateDataset(schema, 7, 500, TEST_LIMITS);
  assert.equal(rows.length, 500);
  for (const row of rows) {
    const n = row.n as number;
    assert.ok(Number.isInteger(n), 'not an integer: ' + n);
    assert.ok(n >= -5 && n <= 7, 'out of range: ' + n);
  }
});

test('string values respect length bounds and regex pattern', () => {
  const schema = parseSchema(
    { fields: { code: { kind: 'string', minLength: 4, maxLength: 6, pattern: '^[a-zA-Z0-9]+$', charset: 'abcXYZ019' } } },
    TEST_LIMITS,
  );
  const { rows } = generateDataset(schema, 99, 300, TEST_LIMITS);
  const re = /^[a-zA-Z0-9]+$/;
  for (const row of rows) {
    const s = row.code as string;
    assert.ok(s.length >= 4 && s.length <= 6, 'bad length: ' + s);
    assert.ok(re.test(s), 'pattern violated: ' + s);
    assert.ok(/^[abcXYZ019]+$/.test(s), 'charset violated: ' + s);
  }
});

test('enum values only come from the declared list', () => {
  const schema = parseSchema({ fields: { e: { kind: 'enum', values: ['red', 'green', 3, null] } } }, TEST_LIMITS);
  const { rows } = generateDataset(schema, 5, 300, TEST_LIMITS);
  const allowed = new Set(['red', 'green', 3, null]);
  for (const row of rows) assert.ok(allowed.has(row.e as never), 'unexpected enum value: ' + row.e);
});

test('date values stay inside [min, max]', () => {
  const schema = parseSchema({ fields: { d: { kind: 'date', min: '2020-02-10', max: '2020-03-15' } } }, TEST_LIMITS);
  const { rows } = generateDataset(schema, 11, 300, TEST_LIMITS);
  for (const row of rows) {
    const d = row.d as string;
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(d), 'not an ISO date: ' + d);
    assert.ok(d >= '2020-02-10' && d <= '2020-03-15', 'date out of range: ' + d);
  }
});

test('single-value ranges are honored exactly', () => {
  const schema = parseSchema(
    { fields: { n: { kind: 'integer', min: 9, max: 9 }, s: { kind: 'string', minLength: 3, maxLength: 3 } } },
    TEST_LIMITS,
  );
  const { rows } = generateDataset(schema, 3, 50, TEST_LIMITS);
  for (const row of rows) {
    assert.equal(row.n, 9);
    assert.equal((row.s as string).length, 3);
  }
});
