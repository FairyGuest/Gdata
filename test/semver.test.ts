import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, satisfies, parseSemver } from '../src/core/semver.ts';
import { ScanError } from '../src/contract/errors.ts';

test('数值比较而非字典序：1.10.0 > 1.9.0', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.ok('1.10.0' < '1.9.0', '字典序会给出错误答案，测试以此确认未用字典序');
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('边界：恰好包含 (<=2.1.5 命中 2.1.5)', () => {
  assert.equal(satisfies('2.1.5', '>=2.0.0 <=2.1.5'), true);
  assert.equal(satisfies('2.1.5', '<=2.1.5'), true);
  assert.equal(satisfies('1.4.2', '1.4.2'), true);
});

test('边界：恰好不包含 (<2.1.5 不命中 2.1.5)', () => {
  assert.equal(satisfies('2.1.5', '>=2.0.0 <2.1.5'), false);
  assert.equal(satisfies('1.10.0', '>=1.0.0 <1.10.0'), false);
  assert.equal(satisfies('1.9.0', '>=1.0.0 <1.10.0'), true);
});

test('caret / tilde / 星号', () => {
  assert.equal(satisfies('1.2.0', '^1.0.0'), true);
  assert.equal(satisfies('2.0.0', '^1.0.0'), false);
  assert.equal(satisfies('2.0.1', '~2.0.0'), true);
  assert.equal(satisfies('2.1.0', '~2.0.0'), false);
  assert.equal(satisfies('9.9.9', '*'), true);
});

test('非法版本与范围抛 INPUT_ERROR', () => {
  assert.throws(() => parseSemver('1.2'), (e) => e instanceof ScanError && e.category === 'INPUT_ERROR');
  assert.throws(() => satisfies('1.0.0', '=>1.0.0'), (e) => e instanceof ScanError && e.category === 'INPUT_ERROR');
});
