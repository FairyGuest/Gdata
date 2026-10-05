// HTTP 集成测试：通过 fastify inject 走完整链路。
// 覆盖：通配符匹配、序号响应、延迟计时、请求记录顺序、复位、错误语义。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../dist/server.js';
import { parseRouteConfig } from '../dist/config/loader.js';

let app, store;

before(async () => {
  const rules = parseRouteConfig([
    { method: 'GET', path: '/api/users/*', response: { status: 200, headers: { 'x-source': 'test' }, body: { user: 'wild' } } },
    { method: 'GET', path: '/api/files/**', response: { status: 200, body: { file: true } } },
    { method: 'GET', path: '/seq', responses: [
      { status: 200, body: { n: 1 } },
      { status: 200, body: { n: 2 } },
      { status: 500, body: { n: 3 } },
    ]},
    { method: 'POST', path: '/orders', bodyMatch: { mode: 'contains', expected: { type: 'vip' } }, response: { status: 201, body: { kind: 'vip' } } },
    { method: 'POST', path: '/orders', response: { status: 200, body: { kind: 'normal' } } },
    { method: 'GET', path: '/slow', response: { status: 200, delayMs: 250, body: { slow: true } } },
  ]);
  ({ app, store } = buildServer({ rules }));
  await app.ready();
});

test('通配符：单段与多段', async () => {
  const r1 = await app.inject({ method: 'GET', url: '/api/users/42' });
  assert.equal(r1.statusCode, 200);
  assert.deepEqual(r1.json(), { user: 'wild' });
  assert.equal(r1.headers['x-source'], 'test');

  const r2 = await app.inject({ method: 'GET', url: '/api/files/a/b/c.txt' });
  assert.equal(r2.statusCode, 200);
  assert.deepEqual(r2.json(), { file: true });

  const r3 = await app.inject({ method: 'GET', url: '/api/users/1/2' });
  assert.equal(r3.statusCode, 404); // 单段 * 不匹配两段
});

test('序号响应：同一 URL 三次调用返回不同结果，第四次复用最后一个', async () => {
  const a = await app.inject({ method: 'GET', url: '/seq' });
  const b = await app.inject({ method: 'GET', url: '/seq' });
  const c = await app.inject({ method: 'GET', url: '/seq' });
  const d = await app.inject({ method: 'GET', url: '/seq' });
  assert.deepEqual([a.statusCode, b.statusCode, c.statusCode, d.statusCode], [200, 200, 500, 500]);
  assert.deepEqual([a.json().n, b.json().n, c.json().n], [1, 2, 3]);
  assert.deepEqual(
    [a.headers['x-mock-sequence'], b.headers['x-mock-sequence'], c.headers['x-mock-sequence'], d.headers['x-mock-sequence']],
    ['1', '2', '3', '4'],
  );
});

test('bodyMatch：vip 走 201，普通走 200', async () => {
  const vip = await app.inject({ method: 'POST', url: '/orders', payload: { type: 'vip', item: 'x' } });
  assert.equal(vip.statusCode, 201);
  assert.deepEqual(vip.json(), { kind: 'vip' });
  const normal = await app.inject({ method: 'POST', url: '/orders', payload: { type: 'normal' } });
  assert.equal(normal.statusCode, 200);
  assert.deepEqual(normal.json(), { kind: 'normal' });
});

test('延迟响应实际耗时 >= delayMs', async () => {
  const t0 = Date.now();
  const r = await app.inject({ method: 'GET', url: '/slow' });
  const elapsed = Date.now() - t0;
  assert.equal(r.statusCode, 200);
  assert.ok(elapsed >= 240, `延迟应 >=240ms，实际 ${elapsed}ms`);
});

test('请求记录：顺序、方法、路径、查询、体均可断言', async () => {
  await app.inject({ method: 'POST', url: '/__mock/reset' });
  await app.inject({ method: 'GET', url: '/api/users/7?verbose=1' });
  await app.inject({ method: 'POST', url: '/orders', payload: { type: 'vip' } });
  await app.inject({ method: 'GET', url: '/nowhere' });
  const { requests } = (await app.inject({ method: 'GET', url: '/__mock/requests' })).json();
  assert.deepEqual(requests.map(r => r.method + ' ' + r.path), [
    'GET /api/users/7',
    'POST /orders',
    'GET /nowhere',
  ]);
  assert.deepEqual(requests.map(r => r.seq), [1, 2, 3]);
  assert.equal(requests[0].query.verbose, '1');
  assert.deepEqual(requests[1].body, { type: 'vip' });
  assert.equal(requests[1].matchedRuleId, 'POST:/orders');
  assert.equal(requests[2].matchedRuleId, null);       // 未匹配也记录
  assert.equal(requests[2].respondedStatus, 404);
});

test('reset 后序号响应从头开始', async () => {
  await app.inject({ method: 'POST', url: '/__mock/reset' });
  const r = await app.inject({ method: 'GET', url: '/seq' });
  assert.equal(r.json().n, 1);
  assert.equal(r.headers['x-mock-sequence'], '1');
});

test('未匹配路由返回 404 NO_MATCH，且不是成功', async () => {
  const r = await app.inject({ method: 'GET', url: '/definitely-not-configured' });
  assert.equal(r.statusCode, 404);
  assert.equal(r.json().error.category, 'NO_MATCH');
});

test('统计接口反映命中计数', async () => {
  await app.inject({ method: 'POST', url: '/__mock/reset' });
  await app.inject({ method: 'GET', url: '/seq' });
  await app.inject({ method: 'GET', url: '/seq' });
  await app.inject({ method: 'GET', url: '/nope' });
  const stats = (await app.inject({ method: 'GET', url: '/__mock/stats' })).json();
  assert.equal(stats.totalRequests, 3);
  assert.equal(stats.unmatchedRequests, 1);
  assert.deepEqual(stats.rules.find(r => r.ruleId === 'GET:/seq'), { ruleId: 'GET:/seq', hits: 2 });
});
