import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockEngine } from '../src/core/engine.ts';
import { MockError } from '../src/contracts/errors.ts';
import type { RouteConfig } from '../src/contracts/types.ts';

const seqRoute: RouteConfig = {
  id: 'seq',
  method: 'GET',
  path: '/items/*',
  responses: [
    { status: 200, body: { n: 1 } },
    { status: 201, body: { n: 2 } },
  ],
};

test('同一 URL 按调用序号返回不同响应', () => {
  const engine = new MockEngine([seqRoute]);
  const r1 = engine.execute({ method: 'GET', path: '/items/7', body: '' });
  const r2 = engine.execute({ method: 'GET', path: '/items/7', body: '' });
  assert.equal(r1?.response.status, 200);
  assert.deepEqual(r1?.response.body, { n: 1 });
  assert.equal(r1?.callIndex, 1);
  assert.equal(r2?.response.status, 201);
  assert.deepEqual(r2?.response.body, { n: 2 });
  assert.equal(r2?.callIndex, 2);
});

test('序号耗尽默认抛 STATE_CONFLICT / SEQUENCE_EXHAUSTED', () => {
  const engine = new MockEngine([seqRoute]);
  engine.execute({ method: 'GET', path: '/items/7', body: '' });
  engine.execute({ method: 'GET', path: '/items/7', body: '' });
  assert.throws(() => engine.execute({ method: 'GET', path: '/items/7', body: '' }), (err) => {
    assert.ok(err instanceof MockError);
    assert.equal(err.category, 'STATE_CONFLICT');
    assert.equal(err.code, 'SEQUENCE_EXHAUSTED');
    return true;
  });
});

test('onExhausted=repeat-last 时重复最后一个响应', () => {
  const engine = new MockEngine([{ ...seqRoute, onExhausted: 'repeat-last' }]);
  engine.execute({ method: 'GET', path: '/items/7', body: '' });
  engine.execute({ method: 'GET', path: '/items/7', body: '' });
  const r3 = engine.execute({ method: 'GET', path: '/items/7', body: '' });
  assert.equal(r3?.response.status, 201);
});

test('请求体 json 部分匹配决定命中', () => {
  const engine = new MockEngine([{
    id: 'json-route',
    method: 'POST',
    path: '/orders',
    bodyMatch: { json: { sku: 'A-1' } },
    responses: [{ status: 201, body: { ok: true } }],
  }]);
  const hit = engine.execute({ method: 'POST', path: '/orders', body: '{"sku":"A-1","qty":3}' });
  assert.equal(hit?.response.status, 201);
  const miss = engine.execute({ method: 'POST', path: '/orders', body: '{"sku":"B-2"}' });
  assert.equal(miss, null);
});

test('更具体的路由优先于通配路由', () => {
  const engine = new MockEngine([
    { id: 'wild', method: 'GET', path: '/api/**', responses: [{ status: 200, body: 'wild' }] },
    { id: 'exact', method: 'GET', path: '/api/special', responses: [{ status: 200, body: 'exact' }] },
  ]);
  const r = engine.execute({ method: 'GET', path: '/api/special', body: '' });
  assert.equal(r?.routeId, 'exact');
});

test('方法不匹配则不命中', () => {
  const engine = new MockEngine([seqRoute]);
  assert.equal(engine.execute({ method: 'POST', path: '/items/7', body: '' }), null);
});

test('reset 清零调用计数', () => {
  const engine = new MockEngine([seqRoute]);
  engine.execute({ method: 'GET', path: '/items/7', body: '' });
  engine.reset();
  const r = engine.execute({ method: 'GET', path: '/items/7', body: '' });
  assert.equal(r?.callIndex, 1);
});
