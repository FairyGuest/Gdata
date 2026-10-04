import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateChain } from '../src/core/chainValidator.ts';
import { VirtualClock } from '../src/clock/clock.ts';
import {
  FIXTURE_NOW,
  buildBrokenChain,
  buildExactlyExpiredChain,
  buildFullChain,
  buildNearExpiryChain,
  fixtureKeyStore,
  makeCert,
} from '../src/fixtures/caFixtures.ts';
import type { ValidatorConfig } from '../src/domain/types.ts';

const CFG: ValidatorConfig = { renewalWarningDays: 30, renewalCriticalDays: 7, maxChainLength: 8 };
const clockAt = (iso: string) => new VirtualClock(iso);

test('完整链验证通过，并给出逐级剩余有效期', () => {
  const chain = buildFullChain();
  const r = validateChain(chain.all, 'cert-leaf', fixtureKeyStore, clockAt(FIXTURE_NOW), CFG);
  assert.equal(r.valid, true);
  assert.equal(r.failure, undefined);
  // 链结构：叶(0) -> 中间(1) -> 根(2)
  assert.deepEqual(r.chain.map((l) => l.level), [0, 1, 2]);
  assert.deepEqual(r.chain.map((l) => l.certId), ['cert-leaf', 'cert-intermediate', 'cert-root']);
  assert.ok(r.chain.every((l) => l.status === 'ok'));
  // 剩余天数为手工计算值：90-10 / 365-10 / 3650-10
  assert.deepEqual(r.chain.map((l) => l.remainingDays), [80, 355, 3640]);
  assert.deepEqual(r.renewals.map((a) => a.severity), ['ok', 'ok', 'ok']);
});

test('链断裂：缺少中间 CA，定位到第 0 级 CHAIN_BREAK', () => {
  const certs = buildBrokenChain();
  const r = validateChain(certs, 'cert-leaf', fixtureKeyStore, clockAt(FIXTURE_NOW), CFG);
  assert.equal(r.valid, false);
  assert.equal(r.failure?.code, 'CHAIN_BREAK');
  assert.equal(r.failure?.level, 0);
  assert.equal(r.failure?.certId, 'cert-leaf');
  assert.match(r.failure!.reason, /Demo Intermediate CA/);
});

test('证书恰好过期：notAfter == now 判定为 EXPIRED', () => {
  const certs = buildExactlyExpiredChain();
  const r = validateChain(certs, 'cert-leaf', fixtureKeyStore, clockAt(FIXTURE_NOW), CFG);
  assert.equal(r.valid, false);
  assert.equal(r.failure?.code, 'EXPIRED');
  assert.equal(r.failure?.level, 0);
  assert.equal(r.renewals[0].severity, 'expired');
});

test('续期阈值：剩余 10 天触发 warning，剩余 3 天触发 critical', () => {
  const certs = buildNearExpiryChain();
  const r = validateChain(certs, 'cert-leaf', fixtureKeyStore, clockAt(FIXTURE_NOW), CFG);
  assert.equal(r.valid, true);
  assert.equal(r.renewals[0].remainingDays, 10);
  assert.equal(r.renewals[0].severity, 'warning');
  // 推进虚拟时钟 7 天：剩余 3 天，应落入 critical（<= 7 天）
  const clock = clockAt(FIXTURE_NOW);
  clock.advanceDays(7);
  const r2 = validateChain(certs, 'cert-leaf', fixtureKeyStore, clock, CFG);
  assert.equal(r2.renewals[0].remainingDays, 3);
  assert.equal(r2.renewals[0].severity, 'critical');
});

test('签名无效：伪造签名定位到第 0 级 SIGNATURE_INVALID', () => {
  const chain = buildFullChain();
  const forged = { ...chain.leaf, signature: '0'.repeat(64) };
  const r = validateChain([forged, chain.intermediate, chain.root], 'cert-leaf', fixtureKeyStore, clockAt(FIXTURE_NOW), CFG);
  assert.equal(r.valid, false);
  assert.equal(r.failure?.code, 'SIGNATURE_INVALID');
  assert.equal(r.failure?.level, 0);
});

test('中间证书不能自签名：目标自签名直接失败', () => {
  const selfSigned = makeCert({
    id: 'cert-evil', subject: 'evil.local', issuer: 'evil.local',
    validFromDays: -1, validForDays: 30, keyUsage: ['digitalSignature'],
    signWithKey: 'any-key',
  });
  const r = validateChain([selfSigned], 'cert-evil', fixtureKeyStore, clockAt(FIXTURE_NOW), CFG);
  assert.equal(r.valid, false);
  assert.equal(r.failure?.code, 'SELF_SIGNED_INTERMEDIATE');
  assert.equal(r.failure?.level, 0);
});

test('中间 CA 过期：定位到第 1 级 EXPIRED', () => {
  const chain = buildFullChain();
  const clock = clockAt(FIXTURE_NOW);
  clock.advanceDays(360); // 叶(90天)已过期 -> 先命中叶
  const r1 = validateChain(chain.all, 'cert-leaf', fixtureKeyStore, clock, CFG);
  assert.equal(r1.failure?.level, 0);
  // 只让中间 CA 过期：重签短期中间 CA（第 50 天到期）与第 90 天生效的叶，时钟走到第 100 天
  const shortIntermediate = makeCert({
    id: 'cert-intermediate', subject: 'Demo Intermediate CA', issuer: 'Demo Root CA',
    validFromDays: -10, validForDays: 60, keyUsage: ['keyCertSign'],
  });
  const freshLeaf = makeCert({
    id: 'cert-leaf', subject: 'service.demo.local', issuer: 'Demo Intermediate CA',
    validFromDays: 90, validForDays: 90, keyUsage: ['digitalSignature'],
  });
  const clock2 = clockAt(FIXTURE_NOW);
  clock2.advanceDays(100);
  const r2 = validateChain([freshLeaf, shortIntermediate, chain.root], 'cert-leaf', fixtureKeyStore, clock2, CFG);
  assert.equal(r2.valid, false);
  assert.equal(r2.failure?.code, 'EXPIRED');
  assert.equal(r2.failure?.level, 1);
  assert.equal(r2.failure?.certId, 'cert-intermediate');
});

test('目标证书不存在：CHAIN_BREAK 且 level=0', () => {
  const chain = buildFullChain();
  const r = validateChain(chain.all, 'cert-missing', fixtureKeyStore, clockAt(FIXTURE_NOW), CFG);
  assert.equal(r.valid, false);
  assert.equal(r.failure?.code, 'CHAIN_BREAK');
});
