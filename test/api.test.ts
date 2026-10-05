import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MockEngine } from '../src/core/engine.ts';
import { RequestRecorder } from '../src/state/recorder.ts';
import { startMockServer, type MockServerHandle } from '../src/adapters/http.ts';
import { parseRoutes } from '../src/config/loader.ts';

let handle: MockServerHandle;
let base: string;
let recorder: RequestRecorder;

before(async () => {
  const routes = parseRoutes([
    {
      id: 'user', method: 'GET', path: '/api/users/*',
      responses: [
        { status: 200, headers: { 'x-mock': 'first' }, body: { attempt: 1 } },
        { status: 200, headers: { 'x-mock': 'second' }, body: { attempt: 2 } },
        { status: 500, body: { attempt: 'boom' } },
      ],
    },
    {
      id: 'slow', method: 'GET', path: '/api/slow',
      responses: [{ status: 200, delayMs: 200, body: { slow: true } }],
      onExhausted: 'repeat-last',
    },
    {
      id: 'order', method: 'POST', path: '/api/orders',
      bodyMatch: { json: { sku: 'A-1' } },
      responses: [{ status: 201, body: { orderId: 'ord-1' } }],
      onExhausted: 'repeat-last',
    },
  ]);
  const engine = new MockEngine(routes);
  recorder = new RequestRecorder();
  handle = await startMockServer({ engine, recorder, port: 0 });
  base = `http://127.0.0.1:${handle.port}`;
});

after(async () => {
  await handle.close();
  recorder.close();
});

test('通配符路由命中并返回自定义响应头', async () => {
  const res = await fetch(`${base}/api/users/42`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-mock'), 'first');
  assert.deepEqual(await res.json(), { attempt: 1 });
});

test('同一路由按序号返回不同响应，耗尽后返回 500 STATE_CONFLICT', async () => {
  const r2 = await fetch(`${base}/api/users/42`);
  assert.equal(r2.headers.get('x-mock'), 'second');
  const r3 = await fetch(`${base}/api/users/42`);
  assert.equal(r3.status, 500);
  const r4 = await fetch(`${base}/api/users/42`);
  assert.equal(r4.status, 500);
  const payload = await r4.json();
  assert.equal(payload.error.category, 'STATE_CONFLICT');
  assert.equal(payload.error.code, 'SEQUENCE_EXHAUSTED');
});

test('延迟响应实际耗时 >= delayMs', async () => {
  const start = performance.now();
  const res = await fetch(`${base}/api/slow`);
  const elapsed = performance.now() - start;
  assert.equal(res.status, 200);
  assert.ok(elapsed >= 190, `延迟应 >=190ms，实际 ${elapsed.toFixed(1)}ms`);
});

test('请求体匹配命中 201，不匹配返回 404 NO_MATCH', async () => {
  const hit = await fetch(`${base}/api/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'A-1', qty: 2 }),
  });
  assert.equal(hit.status, 201);
  const miss = await fetch(`${base}/api/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'ZZ' }),
  });
  assert.equal(miss.status, 404);
  const payload = await miss.json();
  assert.equal(payload.error.category, 'NO_MATCH');
  assert.equal(payload.error.code, 'MOCK_NO_ROUTE');
});

test('请求记录保留调用顺序、查询参数与请求体', async () => {
  const res = await fetch(`${base}/__requests`);
  const { requests } = await res.json();
  assert.ok(requests.length >= 7, `至少 7 条记录，实际 ${requests.length}`);
  const seqs = requests.map((r: { seq: number }) => r.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  const paths = requests.map((r: { path: string }) => r.path);
  const firstUsers = paths.indexOf('/api/users/42');
  const firstSlow = paths.indexOf('/api/slow');
  assert.ok(firstUsers < firstSlow, '调用顺序应与发起顺序一致');
  const order = requests.find((r: { path: string }) => r.path === '/api/orders' && r.matched);
  assert.ok(order);
  assert.equal(JSON.parse(order.body).sku, 'A-1');
  assert.equal(order.routeId, 'order');
});

test('/__verify 断言调用次数，/__reset 清空一切', async () => {
  const v1 = await fetch(`${base}/__verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'GET', path: '/api/users/42', times: 4 }),
  });
  assert.deepEqual(await v1.json(), { ok: true, actual: 4, expected: 4 });

  const reset = await fetch(`${base}/__reset`, { method: 'POST' });
  assert.equal(reset.status, 200);
  const after1 = await fetch(`${base}/__requests`);
  assert.deepEqual((await after1.json()).requests, []);

  // 计数器也已清零：再次调用回到第一个响应
  const r = await fetch(`${base}/api/users/42`);
  assert.equal(r.headers.get('x-mock'), 'first');
});

test('管理接口输入错误返回 400 INPUT_ERROR', async () => {
  const res = await fetch(`${base}/__verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 400);
  const payload = await res.json();
  assert.equal(payload.error.category, 'INPUT_ERROR');
});
