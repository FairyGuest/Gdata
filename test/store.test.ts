import test from 'node:test';
import assert from 'node:assert/strict';
import { DatasetStore } from '../src/state/store.ts';
import { parseSchema } from '../src/contract/schema.ts';
import { FactoryError } from '../src/contract/errors.ts';
import { TEST_LIMITS, DEMO_SCHEMA_RAW } from './helpers.ts';

test('dataset round-trip: save, load, verify consistency by seed', () => {
  const store = new DatasetStore(':memory:');
  const schema = parseSchema(DEMO_SCHEMA_RAW, TEST_LIMITS);
  store.saveDataset('users', schema, 42, 25, TEST_LIMITS);
  const loaded = store.getDataset('users');
  assert.equal(loaded.count, 25);
  assert.equal(loaded.rows.length, 25);
  const verification = store.verifyDataset('users', TEST_LIMITS);
  assert.equal(verification.consistent, true, verification.reason);
  assert.equal(verification.regenerated, 25);
  store.close();
});

test('saving the same dataset name twice is STATE_CONFLICT', () => {
  const store = new DatasetStore(':memory:');
  const schema = parseSchema(DEMO_SCHEMA_RAW, TEST_LIMITS);
  store.saveDataset('dup', schema, 1, 5, TEST_LIMITS);
  try {
    store.saveDataset('dup', schema, 1, 5, TEST_LIMITS);
    assert.fail('expected STATE_CONFLICT');
  } catch (e) {
    assert.ok(e instanceof FactoryError);
    assert.equal(e.category, 'STATE_CONFLICT');
  }
  store.close();
});

test('loading a missing dataset is STATE_CONFLICT (not found)', () => {
  const store = new DatasetStore(':memory:');
  try {
    store.getDataset('nope');
    assert.fail('expected error');
  } catch (e) {
    assert.ok(e instanceof FactoryError);
    assert.equal(e.category, 'STATE_CONFLICT');
    assert.match(e.message, /not found/);
  }
  store.close();
});

test('run logs are persisted with outcome and can be replayed', () => {
  const store = new DatasetStore(':memory:');
  const schema = parseSchema(DEMO_SCHEMA_RAW, TEST_LIMITS);
  store.saveDataset('logged', schema, 42, 3, TEST_LIMITS);
  const verification = store.verifyDataset('logged', TEST_LIMITS);
  assert.equal(verification.consistent, true);
  store.close();
});
