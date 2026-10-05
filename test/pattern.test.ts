import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePattern, matchPath } from '../src/core/pattern.ts';
import { MockError } from '../src/contracts/errors.ts';

test('精确路径只命中自身', () => {
  const p = compilePattern('/api/users');
  assert.equal(matchPath(p, '/api/users'), true);
  assert.equal(matchPath(p, '/api/users/1'), false);
  assert.equal(matchPath(p, '/api/user'), false);
});

test('单星通配不跨段', () => {
  const p = compilePattern('/api/users/*');
  assert.equal(matchPath(p, '/api/users/42'), true);
  assert.equal(matchPath(p, '/api/users/'), true);
  assert.equal(matchPath(p, '/api/users/42/posts'), false);
});

test('双星通配可跨段', () => {
  const p = compilePattern('/api/**');
  assert.equal(matchPath(p, '/api/a'), true);
  assert.equal(matchPath(p, '/api/a/b/c'), true);
  assert.equal(matchPath(p, '/other/a'), false);
});

test('非绝对路径模式抛 COMPUTATION_FAILURE', () => {
  assert.throws(() => compilePattern('api/users'), (err) => {
    assert.ok(err instanceof MockError);
    assert.equal(err.category, 'COMPUTATION_FAILURE');
    assert.equal(err.code, 'PATTERN_NOT_ABSOLUTE');
    return true;
  });
});
