/** 本地演示：内存 SQLite + 虚拟时钟，依次演示四大场景 */
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
  console.log('演示服务已启动: ' + base + '（虚拟时钟 = ' + FIXTURE_NOW + '）');

  const scenarios: Array<{ name: string; certs: () => ReturnType<typeof buildFullChain>['all'] }> = [
    { name: '场景1 完整链通过', certs: () => buildFullChain().all },
    { name: '场景2 链断裂定位', certs: () => buildBrokenChain() },
    { name: '场景3 证书恰好过期', certs: () => buildExactlyExpiredChain() },
    { name: '场景4 续期阈值（剩余10天）', certs: () => buildNearExpiryChain() },
  ];

  for (const s of scenarios) {
    console.log('\n=== ' + s.name + ' ===');
    const loadRes = await fetch(base + '/certs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replace: true, certs: s.certs() }),
    });
    console.log('装载证书:', await loadRes.json());
    const res = await fetch(base + '/validate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetId: 'cert-leaf' }),
    });
    const body = await res.json();
    console.log('runId:', body.runId);
    console.log('valid:', body.valid);
    if (body.failure) console.log('failure:', body.failure);
    for (const link of body.chain) {
      console.log('  L' + link.level + ' ' + link.subject + ' -> ' + link.status +
        (link.remainingDays !== undefined ? ' (剩余 ' + link.remainingDays + ' 天)' : '') +
        (link.reason ? ' [' + link.reason + ']' : ''));
    }
    for (const adv of body.renewals) {
      console.log('  续期建议[' + adv.severity + '] ' + adv.message);
    }
  }

  await app.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
