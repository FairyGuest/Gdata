import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDataset } from '../src/kernel/generate.ts';
import { parseSchema } from '../src/contract/schema.ts';
import { TEST_LIMITS } from './helpers.ts';

const NESTED_RAW = {
  fields: {
    user: {
      kind: 'object',
      properties: {
        id: { kind: 'integer', min: 1, max: 1000 },
        tags: { kind: 'array', minItems: 1, maxItems: 3, items: { kind: 'string', minLength: 2, maxLength: 4 } },
        address: {
          kind: 'object',
          properties: {
            city: { kind: 'enum', values: ['Shanghai', 'Beijing'] },
            zip: { kind: 'string', minLength: 6, maxLength: 6, charset: '0123456789' },
          },
        },
      },
    },
  },
};

test('nested objects and arrays are generated recursively and deterministically', () => {
  const schema = parseSchema(NESTED_RAW, TEST_LIMITS);
  const a = generateDataset(schema, 2026, 30, TEST_LIMITS);
  const b = generateDataset(schema, 2026, 30, TEST_LIMITS);
  assert.deepEqual(a.rows, b.rows);
  for (const row of a.rows) {
    const user = row.user as Record<string, unknown>;
    assert.ok(typeof user.id === 'number');
    const tags = user.tags as string[];
    assert.ok(Array.isArray(tags) && tags.length >= 1 && tags.length <= 3, 'tags length out of range');
    for (const t of tags) assert.ok(t.length >= 2 && t.length <= 4);
    const address = user.address as Record<string, unknown>;
    assert.ok(address.city === 'Shanghai' || address.city === 'Beijing');
    assert.ok(/^[0-9]{6}$/.test(address.zip as string));
  }
});

test('frozen nested reference row for seed 2026', () => {
  const schema = parseSchema(NESTED_RAW, TEST_LIMITS);
  const { rows } = generateDataset(schema, 2026, 1, TEST_LIMITS);
  assert.deepEqual(rows[0], {
    user: {
      id: 456,
      tags: ['Mjn'],
      address: { city: 'Beijing', zip: '200631' },
    },
  });
});

test('array of arrays and empty arrays are supported', () => {
  const schema = parseSchema(
    {
      fields: {
        matrix: {
          kind: 'array', minItems: 0, maxItems: 2,
          items: { kind: 'array', minItems: 0, maxItems: 2, items: { kind: 'integer', min: 0, max: 1 } },
        },
      },
    },
    TEST_LIMITS,
  );
  const { rows } = generateDataset(schema, 8, 100, TEST_LIMITS);
  for (const row of rows) {
    const m = row.matrix as unknown[][];
    assert.ok(Array.isArray(m) && m.length <= 2);
    for (const inner of m) {
      assert.ok(Array.isArray(inner) && inner.length <= 2);
      for (const v of inner) assert.ok(v === 0 || v === 1);
    }
  }
});
