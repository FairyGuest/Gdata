import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../dist/server.js';
import { RunStore } from '../dist/store.js';
import { DEFAULT_CONFIG } from '../dist/config.js';

function makeApp() {
  return buildServer({ ...DEFAULT_CONFIG }, new RunStore(':memory:'));
}

test('POST /runs 缺少 dir => 400 INVALID_INPUT', async () => {
  const app = makeApp();
  const res = await app.inject({ method: 'POST', url: '/runs', payload: {} });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'INVALID_INPUT');
  await app.close();
});

test('POST /runs 目录不存在 => 400 INVALID_INPUT', async () => {
  const app = makeApp();
  const res = await app.inject({ method: 'POST', url: '/runs', payload: { dir: 'no-such-dir' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'INVALID_INPUT');
  await app.close();
});

test('POST /runs timeoutMs 超上限 => 400 INVALID_INPUT', async () => {
  const app = makeApp();
  const res = await app.inject({
    method: 'POST',
    url: '/runs',
    payload: { dir: 'fixtures/sample', timeoutMs: 99999999 },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('GET /runs/:id 不存在 => 404 NOT_FOUND', async () => {
  const app = makeApp();
  const res = await app.inject({ method: 'GET', url: '/runs/does-not-exist' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'NOT_FOUND');
  await app.close();
});

test('GET /health 返回 ok', async () => {
  const app = makeApp();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
  await app.close();
});

test('完整运行 + 历史查询闭环', async () => {
  const app = makeApp();
  const run = await app.inject({
    method: 'POST',
    url: '/runs',
    payload: { dir: 'fixtures/sample', pattern: 'pass.test.js' },
  });
  assert.equal(run.statusCode, 200);
  const summary = run.json();
  assert.equal(summary.status, 'passed');
  assert.equal(summary.total, 2);
  assert.ok(summary.runId);
  assert.ok(summary.logs.length > 0, '应保留运行日志');

  const detail = await app.inject({ method: 'GET', url: '/runs/' + summary.runId });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().total, 2);

  const history = await app.inject({ method: 'GET', url: '/runs?file=pass.test.js' });
  assert.ok(history.json().runs.some((r) => r.runId === summary.runId));
  await app.close();
});