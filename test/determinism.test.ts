import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDataset } from '../src/kernel/generate.ts';
import { parseSchema } from '../src/contract/schema.ts';
import { Rng } from '../src/kernel/rng.ts';
import { TEST_LIMITS, DEMO_SCHEMA_RAW } from './helpers.ts';

// Reference implementation of mulberry32, written independently of src/kernel/rng.ts,
// so the kernel cannot silently drift from the published algorithm.
function referenceMulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('rng matches independently computed mulberry32 stream', () => {
  const rng = new Rng(42);
  const ref = referenceMulberry32(42);
  for (let i = 0; i < 10; i++) {
    assert.equal(rng.next(), ref(), 'draw ' + i + ' diverges from reference implementation');
  }
  // Frozen constants computed once from the reference algorithm (seed 42).
  assert.equal(referenceMulberry32(42)(), 0.6011037519201636);
});

test('same seed produces byte-identical datasets across runs', () => {
  const schema = parseSchema(DEMO_SCHEMA_RAW, TEST_LIMITS);
  const a = generateDataset(schema, 42, 50, TEST_LIMITS);
  const b = generateDataset(schema, 42, 50, TEST_LIMITS);
  assert.deepEqual(a.rows, b.rows);
  assert.equal(JSON.stringify(a.rows), JSON.stringify(b.rows));
});

test('different seeds produce different datasets', () => {
  const schema = parseSchema(DEMO_SCHEMA_RAW, TEST_LIMITS);
  const a = generateDataset(schema, 42, 20, TEST_LIMITS);
  const b = generateDataset(schema, 43, 20, TEST_LIMITS);
  assert.notDeepEqual(a.rows, b.rows);
});

test('frozen reference rows for seed 42 (not produced by the kernel under test)', () => {
  const schema = parseSchema(DEMO_SCHEMA_RAW, TEST_LIMITS);
  const { rows } = generateDataset(schema, 42, 3, TEST_LIMITS);
  // These literals were captured once and frozen; they are the expected answer key.
  assert.deepEqual(rows, [
    { id: 61, name: '0PkGq', role: 'user', birthday: '1999-07-09' },
    { id: 48, name: '2UtmF', role: 'guest', birthday: '1996-09-18' },
    { id: 1, name: 'ZdKbq', role: 'admin', birthday: '1992-01-16' },
  ]);
});

test('string seeds are supported and deterministic', () => {
  const schema = parseSchema(DEMO_SCHEMA_RAW, TEST_LIMITS);
  const a = generateDataset(schema, 'release-2026', 10, TEST_LIMITS);
  const b = generateDataset(schema, 'release-2026', 10, TEST_LIMITS);
  assert.deepEqual(a.rows, b.rows);
});
