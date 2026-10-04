import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/http/server.ts';
import { CertStore } from '../src/adapters/sqliteStore.ts';
import { VirtualClock } from '../src/clock/clock.ts';
import {
  FIXTURE_NOW,
  buildBrokenChain,
  buildFullChain,
  fixtureKeyStore,
} from '../src/fixtures/caFixtures.ts';
import type { ValidatorConfig } from '../src/domain/types.ts';

const CFG: ValidatorConfig = { renewalWarningDays: 30, renewalCriticalDays: 7, maxChainLength: 8 };

function makeApp() {
  const store = new CertStore(':memory:');
  const app = buildServer({ store, clock: new VirtualClock(FIXTURE_NOW), keyStore: fixtureKeyStore, config: CFG });
  return { app, store };
}

test('POST /certs 输入错误返回 400 INPUT_ERROR', async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: 'POST', url: '/certs', payload: { certs: [{ id: 'x' }] } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.category, 'INPUT_ERROR');
  await app.close();
});

test('重复证书 id 返回 409 STATE_CONFLICT', async () => {
  const { app } = makeApp();
  const chain = buildFullChain();
  const first = await app.inject({ method: 'POST', url: '/certs', payload: { certs: chain.all } });
  assert.equal(first.statusCode, 200);
  const dup = await app.inject({ method: 'POST', url: '/certs', payload: { certs: [chain.leaf] } });
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.json().error.category, 'STATE_CONFLICT');
  await app.close();
});

test('完整链通过 + 运行日志可重放', async () => {
  const { app } = makeApp();
  const chain = buildFullChain();
  await app.inject({ method: 'POST', url: '/certs', payload: { certs: chain.all } });
  const res = await app.inject({ method: 'POST', url: '/validate', payload: { targetId: 'cert-leaf' } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.valid, true);
  assert.equal(typeof body.runId, 'string');
  // 重放：同一 runId 应返回完全一致的结果
  const replay = await app.inject({ method: 'GET', url: '/runs/' + body.runId });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json().result.chain, body.chain);
  await app.close();
});

test('断裂链通过接口返回明确失败类别与级别', async () => {
  const { app } = makeApp();
  await app.inject({ method: 'POST', url: '/certs', payload: { certs: buildBrokenChain() } });
  const res = await app.inject({ method: 'POST', url: '/validate', payload: { targetId: 'cert-leaf' } });
  const body = res.json();
  assert.equal(body.valid, false);
  assert.equal(body.failure.code, 'CHAIN_BREAK');
  assert.equal(body.failure.level, 0);
  await app.close();
});

test('缺少 targetId 返回 400，未知 runId 返回 400', async () => {
  const { app } = makeApp();
  const bad = await app.inject({ method: 'POST', url: '/validate', payload: {} });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.category, 'INPUT_ERROR');
  const noRun = await app.inject({ method: 'GET', url: '/runs/does-not-exist' });
  assert.equal(noRun.statusCode, 400);
  await app.close();
});
