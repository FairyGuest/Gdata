import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveGraph, findPaths } from '../src/core/graph.ts';
import { ScanError } from '../src/contract/errors.ts';

const registry = JSON.parse(readFileSync(new URL('../fixtures/registry.json', import.meta.url), 'utf8'));
const LIMITS = { maxNodes: 1000, maxDepth: 50 };

test('深层传递依赖完整解析（6 层链 + 循环分支共 9 节点）', () => {
  const g = resolveGraph(registry, ['app@^1.0.0'], LIMITS);
  assert.equal(g.nodes.size, 9);
  for (const key of ['app@1.0.0','lib-a@1.2.0','lib-b@1.1.0','lib-c@3.0.5','lib-d@1.4.2','lib-e@2.1.5','lib-f@1.10.0','util-left@2.0.1','util-right@1.3.0']) {
    assert.ok(g.nodes.has(key), 'missing node ' + key);
  }
  // 版本选择：lib-e 取满足 >=2.0.0 的最高版 2.1.5；lib-f 取 1.10.0 而非字典序的 1.9.0
  assert.ok(g.nodes.has('lib-e@2.1.5'));
  assert.ok(g.nodes.has('lib-f@1.10.0'));
  assert.ok(!g.nodes.has('lib-f@1.9.0'));
});

test('循环依赖：记录循环边且不展开、不死循环', () => {
  const g = resolveGraph(registry, ['app@^1.0.0'], LIMITS);
  assert.deepEqual(g.cycles, [{ from: 'util-right@1.3.0', to: 'util-left@2.0.1' }]);
  // 循环边不进入邻接表
  assert.ok(!g.edges.get('util-right@1.3.0').includes('util-left@2.0.1'));
});

test('根到深层节点的依赖路径', () => {
  const g = resolveGraph(registry, ['app@^1.0.0'], LIMITS);
  const paths = findPaths(g, ['app@1.0.0'], 'lib-e@2.1.5', 5, 50);
  assert.deepEqual(paths, [['app@1.0.0','lib-a@1.2.0','lib-b@1.1.0','lib-c@3.0.5','lib-d@1.4.2','lib-e@2.1.5']]);
});

test('资源耗尽：节点上限触发 RESOURCE_EXHAUSTED', () => {
  assert.throws(() => resolveGraph(registry, ['app@^1.0.0'], { maxNodes: 3, maxDepth: 50 }),
    (e) => e instanceof ScanError && e.category === 'RESOURCE_EXHAUSTED');
});

test('资源耗尽：深度上限触发 RESOURCE_EXHAUSTED', () => {
  assert.throws(() => resolveGraph(registry, ['app@^1.0.0'], { maxNodes: 1000, maxDepth: 2 }),
    (e) => e instanceof ScanError && e.category === 'RESOURCE_EXHAUSTED');
});

test('输入错误：依赖不存在或范围不可满足', () => {
  assert.throws(() => resolveGraph(registry, ['ghost@^1.0.0'], LIMITS),
    (e) => e instanceof ScanError && e.category === 'INPUT_ERROR');
  assert.throws(() => resolveGraph(registry, ['lib-e@^9.0.0'], LIMITS),
    (e) => e instanceof ScanError && e.category === 'INPUT_ERROR');
});
