// 内核与状态层测试：序号消费、body 匹配、复位、资源上限错误类别。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockKernel } from '../dist/core/kernel.js';
import { MockStore, MAX_RECORDS } from '../dist/state/store.js';
import { parseRouteConfig } from '../dist/config/loader.js';
import { MockServerError } from '../dist/contracts/errors.js';

function makeKernel(config) {
  const store = new MockStore(':memory:');
  return { store, kernel: new MockKernel(parseRouteConfig(config), store) };
}

test('同一 URL 按调用序号返回不同响应，超出后复用最后一个', () => {
  const { kernel } = makeKernel([
    { method: 'GET', path: '/seq', responses: [
      { status: 200, body: 'first' },
      { status: 201, body: 'second' },
      { status: 503, body: 'third' },
    ]},
  ]);
  const rule = kernel.findRule('GET', '/seq', undefined);
  const r1 = kernel.resolve(rule);
  const r2 = kernel.resolve(rule);
  const r3 = kernel.resolve(rule);
  const r4 = kernel.resolve(rule);
  assert.deepEqual([r1.sequence, r2.sequence, r3.sequence, r4.sequence], [1, 2, 3, 4]);
  assert.deepEqual(
    [r1.response.status, r2.response.status, r3.response.status, r4.response.status],
    [200, 201, 503, 503],
  );
});

test('bodyMatch exact 与 contains', () => {
  const { kernel } = makeKernel([
    { method: 'POST', path: '/e', bodyMatch: { mode: 'exact', expected: { a: 1 } }, response: { status: 200 } },
    { method: 'POST', path: '/c', bodyMatch: { mode: 'contains', expected: { a: 1 } }, response: { status: 200 } },
  ]);
  assert.ok(kernel.findRule('POST', '/e', { a: 1 }));
  assert.equal(kernel.findRule('POST', '/e', { a: 1, b: 2 }), null); // exact 不允许多余字段
  assert.ok(kernel.findRule('POST', '/c', { a: 1, b: 2 }));          // contains 允许
  assert.equal(kernel.findRule('POST', '/c', { a: 2 }), null);
});

test('reset 清空记录与命中计数', () => {
  const { store, kernel } = makeKernel([{ method: 'GET', path: '/r', response: { status: 200 } }]);
  const rule = kernel.findRule('GET', '/r', undefined);
  kernel.resolve(rule);
  store.record({ method: 'GET', path: '/r', query: {}, headers: {}, body: undefined, matchedRuleId: rule.id, respondedStatus: 200, receivedAt: new Date().toISOString() });
  assert.equal(store.listRequests().length, 1);
  assert.equal(store.hitsOf(rule.id), 1);
  store.reset();
  assert.equal(store.listRequests().length, 0);
  assert.equal(store.hitsOf(rule.id), 0);
  assert.equal(kernel.resolve(rule).sequence, 1); // 计数已重置
});

test('记录数达到上限抛 RESOURCE_EXHAUSTED（用小上限真实触发）', () => {
  const store = new MockStore(':memory:', 2);
  const rec = { method: 'GET', path: '/x', query: {}, headers: {}, body: undefined, matchedRuleId: null, respondedStatus: 404, receivedAt: new Date().toISOString() };
  store.record(rec);
  store.record(rec);
  assert.throws(() => store.record(rec), (e) => e instanceof MockServerError && e.category === 'RESOURCE_EXHAUSTED');
  store.close();
});

test('请求记录包含方法/路径/查询/头/体且按序排列', () => {
  const store = new MockStore(':memory:');
  const base = { query: { q: '1' }, headers: { 'x-a': 'b' }, body: { k: 'v' }, matchedRuleId: null, respondedStatus: 404 };
  store.record({ ...base, method: 'GET', path: '/first', receivedAt: '2026-10-03T00:00:00Z' });
  store.record({ ...base, method: 'POST', path: '/second', receivedAt: '2026-10-03T00:00:01Z' });
  const reqs = store.listRequests();
  assert.deepEqual(reqs.map(r => r.path), ['/first', '/second']);
  assert.deepEqual(reqs.map(r => r.seq), [1, 2]);
  assert.deepEqual(reqs[0].query, { q: '1' });
  assert.deepEqual(reqs[0].body, { k: 'v' });
  store.close();
});
