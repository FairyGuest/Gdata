// 通配符匹配与配置解析的独立单元测试。期望值全部手工推导，不依赖被测核心生成。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPath, specificity } from '../dist/core/matcher.js';
import { parseRouteConfig } from '../dist/config/loader.js';
import { MockServerError } from '../dist/contracts/errors.js';

test('字面路径精确匹配', () => {
  assert.equal(matchPath('/a/b', '/a/b'), true);
  assert.equal(matchPath('/a/b', '/a/b/c'), false);
  assert.equal(matchPath('/a/b', '/a'), false);
});

test('* 匹配单段', () => {
  assert.equal(matchPath('/api/users/*', '/api/users/42'), true);
  assert.equal(matchPath('/api/users/*', '/api/users/42/posts'), false);
  assert.equal(matchPath('/api/users/*', '/api/users'), false);
});

test('** 匹配任意深度（含零段）', () => {
  assert.equal(matchPath('/api/files/**', '/api/files'), true);
  assert.equal(matchPath('/api/files/**', '/api/files/a'), true);
  assert.equal(matchPath('/api/files/**', '/api/files/a/b/c.txt'), true);
  assert.equal(matchPath('/api/files/**', '/api/other'), false);
});

test('段内 * 通配', () => {
  assert.equal(matchPath('/assets/*.png', '/assets/logo.png'), true);
  assert.equal(matchPath('/assets/*.png', '/assets/logo.jpg'), false);
});

test('优先级：字面 > 段内* > 整段* > **', () => {
  assert.ok(specificity('/a/b/c') > specificity('/a/*/c'));
  assert.ok(specificity('/a/*/c') > specificity('/a/*/*'));
  assert.ok(specificity('/a/*/*') > specificity('/a/**'));
});

test('配置解析：同 method+path 多条合并为序号序列', () => {
  const rules = parseRouteConfig([
    { method: 'get', path: '/x', response: { status: 200 } },
    { method: 'GET', path: '/x', response: { status: 500 } },
  ]);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 'GET:/x');
  assert.deepEqual(rules[0].responses.map(r => r.status), [200, 500]);
});

test('配置解析：bodyMatch 不同的同路径条目是独立规则并消歧 id', () => {
  const rules = parseRouteConfig([
    { method: 'POST', path: '/o', bodyMatch: { mode: 'contains', expected: { t: 1 } }, response: { status: 201 } },
    { method: 'POST', path: '/o', response: { status: 200 } },
  ]);
  assert.equal(rules.length, 2);
  assert.equal(rules[0].id, 'POST:/o');
  assert.equal(rules[1].id, 'POST:/o#2');
});

test('配置解析：非法输入抛出 INPUT_ERROR 类别', () => {
  const cases = [
    [{ method: 'FOO', path: '/x', response: { status: 200 } }],
    [{ method: 'GET', path: 'x', response: { status: 200 } }],
    [{ method: 'GET', path: '/x', response: { status: 99 } }],
    [{ method: 'GET', path: '/x', response: { status: 200, delayMs: -1 } }],
    [{ method: 'GET', path: '/x', response: { status: 200, delayMs: 99999 } }],
    [{ method: 'GET', path: '/x' }],
    [{ method: 'GET', path: '/x', bodyMatch: { mode: 'nope', expected: {} }, response: { status: 200 } }],
  ];
  for (const c of cases) {
    assert.throws(() => parseRouteConfig(c), (e) => e instanceof MockServerError && e.category === 'INPUT_ERROR');
  }
});
