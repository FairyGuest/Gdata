/**
 * 一键验收：按固定顺序演练全部场景，逐步打印请求、响应与判定。
 * 全部通过退出 0，任一失败非 0 退出并指出失败场景。
 */
import { buildServer } from '../src/http/server.ts';
import { CertStore } from '../src/adapters/sqliteStore.ts';
import { VirtualClock } from '../src/clock/clock.ts';
import {
  FIXTURE_NOW,
  buildBrokenChain,
  buildExactlyExpiredChain,
  buildFullChain,
  buildNearExpiryChain,
  fixtureKeyStore,
} from '../src/fixtures/caFixtures.ts';
import type { Certificate } from '../src/domain/types.ts';

interface Check { label: string; pass: boolean }

interface Scenario {
  name: string;
  certs: () => Certificate[];
  expect: (body: Record<string, unknown>) => Check[];
}

const scenarios: Scenario[] = [
  {
    name: '场景1 完整链通过',
    certs: () => buildFullChain().all,
    expect: (b) => [
      { label: 'valid === true', pass: b.valid === true },
      { label: '链长度为 3', pass: (b.chain as unknown[]).length === 3 },
      { label: 'runId 已生成', pass: typeof b.runId === 'string' },
    ],
  },
  {
    name: '场景2 链断裂定位（缺中间 CA）',
    certs: () => buildBrokenChain(),
    expect: (b) => {
      const f = b.failure as { code?: string; level?: number } | undefined;
      return [
        { label: 'valid === false', pass: b.valid === false },
        { label: 'failure.code === CHAIN_BREAK', pass: f?.code === 'CHAIN_BREAK' },
        { label: 'failure.level === 0', pass: f?.level === 0 },
      ];
    },
  },
  {
    name: '场景3 证书恰好过期（notAfter == now）',
    certs: () => buildExactlyExpiredChain(),
    expect: (b) => {
      const f = b.failure as { code?: string; level?: number } | undefined;
      return [
        { label: 'valid === false', pass: b.valid === false },
        { label: 'failure.code === EXPIRED', pass: f?.code === 'EXPIRED' },
        { label: 'failure.level === 0', pass: f?.level === 0 },
      ];
    },
  },
  {
    name: '场景4 续期阈值（剩余10天 -> warning）',
    certs: () => buildNearExpiryChain(),
    expect: (b) => {
      const renewals = b.renewals as Array<{ remainingDays?: number; severity?: string }>;
      return [
        { label: 'valid === true', pass: b.valid === true },
        { label: '叶证书剩余 10 天', pass: renewals[0]?.remainingDays === 10 },
        { label: '叶证书续期级别为 warning', pass: renewals[0]?.severity === 'warning' },
      ];
    },
  },
];

async function main(): Promise<void> {
  const store = new CertStore(':memory:');
  const clock = new VirtualClock(FIXTURE_NOW);
  const app = buildServer({
    store, clock, keyStore: fixtureKeyStore,
    config: { renewalWarningDays: 30, renewalCriticalDays: 7, maxChainLength: 8 },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const base = 'http://127.0.0.1:' + (typeof addr === 'object' && addr ? addr.port : 0);
  console.log('[accept] 服务已启动 ' + base + '，虚拟时钟 = ' + FIXTURE_NOW);

  let failed: string | null = null;

  for (const s of scenarios) {
    console.log('\n[accept] === ' + s.name + ' ===');
    const loadBody = { replace: true, certs: s.certs() };
    console.log('[accept] 请求 POST /certs (' + loadBody.certs.length + ' 张证书, replace=true)');
    const loadRes = await fetch(base + '/certs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(loadBody),
    });
    console.log('[accept] 响应 ' + loadRes.status + ':', JSON.stringify(await loadRes.json()));

    const validateBody = { targetId: 'cert-leaf' };
    console.log('[accept] 请求 POST /validate:', JSON.stringify(validateBody));
    const res = await fetch(base + '/validate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validateBody),
    });
    const body = await res.json();
    console.log('[accept] 响应 ' + res.status + ':', JSON.stringify(body, null, 2));

    if (res.status !== 200) {
      failed = s.name + '（HTTP ' + res.status + '）';
      break;
    }
    for (const check of s.expect(body)) {
      console.log('[accept] 判定 ' + (check.pass ? 'PASS' : 'FAIL') + ': ' + check.label);
      if (!check.pass && !failed) failed = s.name + '（判定失败: ' + check.label + '）';
    }
    if (failed) break;
  }

  await app.close();

  if (failed) {
    console.error('\n[accept] 验收失败: ' + failed);
    process.exit(1);
  }
  console.log('\n[accept] 全部场景通过');
}

main().catch((err) => { console.error('[accept] 执行异常:', err); process.exit(1); });
