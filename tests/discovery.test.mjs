import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patternToRegExp, discoverTestFiles, topoSort } from '../dist/discovery.js';

test('patternToRegExp 支持 * 与 **', () => {
  assert.ok(patternToRegExp('*.test.js').test('a.test.js'));
  assert.ok(!patternToRegExp('*.test.js').test('sub/a.test.js'));
  assert.ok(patternToRegExp('**/*.test.js').test('sub/a.test.js'));
  assert.ok(!patternToRegExp('*.test.js').test('a.spec.js'));
});

test('patternToRegExp 拒绝非法模式', () => {
  assert.throws(() => patternToRegExp('../x'), /INVALID_INPUT|非法/);
  assert.throws(() => patternToRegExp(''), /非法/);
});

test('discoverTestFiles 在 fixtures 目录按模式发现文件', () => {
  const files = discoverTestFiles({ dir: 'fixtures/sample', pattern: '*.test.js', maxFiles: 100 });
  assert.deepEqual(files, [
    'fail.test.js',
    'parallel-a.test.js',
    'parallel-b.test.js',
    'pass.test.js',
    'timeout.test.js',
  ]);
  const only = discoverTestFiles({ dir: 'fixtures/sample', pattern: 'pass.test.js', maxFiles: 100 });
  assert.deepEqual(only, ['pass.test.js']);
});

test('discoverTestFiles 对不存在的目录报 INVALID_INPUT', () => {
  assert.throws(
    () => discoverTestFiles({ dir: 'no-such-dir', pattern: '*', maxFiles: 10 }),
    (e) => e.code === 'INVALID_INPUT',
  );
});

test('discoverTestFiles 超上限报 RESOURCE_EXHAUSTED', () => {
  assert.throws(
    () => discoverTestFiles({ dir: 'fixtures/sample', pattern: '*.test.js', maxFiles: 2 }),
    (e) => e.code === 'RESOURCE_EXHAUSTED',
  );
});

test('topoSort 按依赖排序', () => {
  const ordered = topoSort(['b.test.js', 'a.test.js'], { 'b.test.js': ['a.test.js'] });
  assert.deepEqual(ordered, ['a.test.js', 'b.test.js']);
});

test('topoSort 循环依赖报 INVALID_INPUT', () => {
  assert.throws(
    () => topoSort(['a', 'b'], { a: ['b'], b: ['a'] }),
    (e) => e.code === 'INVALID_INPUT',
  );
});

test('topoSort 依赖未知文件报 INVALID_INPUT', () => {
  assert.throws(
    () => topoSort(['a'], { a: ['ghost'] }),
    (e) => e.code === 'INVALID_INPUT',
  );
});