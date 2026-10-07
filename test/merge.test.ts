import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLayers } from '../src/core/merge.ts';
import { validateLayer } from '../src/contract/validate.ts';
import { ServiceError } from '../src/contract/types.ts';

test('deep merge: nested objects merge recursively to leaves', () => {
  const { effective } = mergeLayers({
    base: { a: { x: 1, y: 2 }, b: 1 },
    env: { a: { y: 20, z: 30 } },
    instance: {},
  });
  assert.deepEqual(effective, { a: { x: 1, y: 20, z: 30 }, b: 1 });
});

test('scalar override: later layer wins', () => {
  const { effective } = mergeLayers({
    base: { port: 8080 },
    env: { port: 9090 },
    instance: { port: 7070 },
  });
  assert.deepEqual(effective, { port: 7070 });
});

test('array replace: arrays are replaced wholesale, not merged element-wise', () => {
  const { effective } = mergeLayers({
    base: { tags: ['a', 'b', 'c'] },
    env: { tags: ['d'] },
    instance: {},
  });
  assert.deepEqual(effective, { tags: ['d'] });
});

test('null delete: null removes the key, including nested keys', () => {
  const { effective } = mergeLayers({
    base: { keep: 1, drop: 2, nested: { stay: true, gone: 'x' } },
    env: { drop: null, nested: { gone: null } },
    instance: {},
  });
  assert.deepEqual(effective, { keep: 1, nested: { stay: true } });
});

test('invalid layer: non-object layer is rejected with layer name', () => {
  assert.throws(
    () => validateLayer('env', [1, 2, 3]),
    (err: unknown) => {
      assert.ok(err instanceof ServiceError);
      assert.equal(err.code, 'INVALID_LAYER');
      assert.equal(err.details?.layer, 'env');
      return true;
    },
  );
});

test('invalid layer: empty key is rejected with layer name and path', () => {
  assert.throws(
    () => validateLayer('instance', { outer: { '': 1 } }),
    (err: unknown) => {
      assert.ok(err instanceof ServiceError);
      assert.equal(err.code, 'INVALID_LAYER');
      assert.equal(err.details?.layer, 'instance');
      assert.equal(err.details?.path, 'outer');
      return true;
    },
  );
});

test('merge log records per-layer applied/deleted counts', () => {
  const { mergeLog } = mergeLayers({
    base: { a: 1, b: 2 },
    env: { b: null, c: 3 },
    instance: {},
  });
  assert.equal(mergeLog.length, 3);
  assert.equal(mergeLog[1].layer, 'env');
  assert.equal(mergeLog[1].deletedKeys, 1);
  assert.equal(mergeLog[1].appliedKeys, 1);
});
