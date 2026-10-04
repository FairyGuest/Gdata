
/** 验收脚本：进程内启动真实 HTTP 服务，按固定顺序演练全部场景。
 *  逐步打印请求、响应与判定；全部通过退出 0，任一失败非 0 并指出失败场景。 */
import { RingLogger } from '../src/domain/logger.ts';
import { SystemClock } from '../src/domain/clock.ts';
import { SqliteStore } from '../src/store/sqliteStore.ts';
import { QuotaService } from '../src/service/quotaService.ts';
import { buildServer } from '../src/http/server.ts';

const GRACE_MS = 800;
const logger = new RingLogger(500, 'accept-run');
const store = new SqliteStore(':memory:');
const service = new QuotaService({ store, clock: new SystemClock(), logger, gracePeriodMs: GRACE_MS });
const app = buildServer({ service, store, logger });
await app.listen({ port: 0, host: '127.0.0.1' });
const addr = app.server.address();
const BASE = 'http://127.0.0.1:' + (typeof addr === 'object' && addr !== null ? addr.port : 0);
console.log('service up on', BASE, '(in-process, real HTTP)');

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; failures.push(name); console.log('  FAIL', name, extra); }
}

interface ApiResult { status: number; body: Record<string, unknown> }

async function api(method: string, path: string, reqBody?: unknown, secret?: string): Promise<ApiResult> {
  const headers: Record<string, string> = reqBody === undefined ? {} : { 'content-type': 'application/json' };
  if (secret) headers['x-api-key'] = secret;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: reqBody === undefined ? undefined : JSON.stringify(reqBody),
  });
  const body = (await res.json()) as Record<string, unknown>;
  console.log('  > ' + method + ' ' + path + (reqBody === undefined ? '' : ' ' + JSON.stringify(reqBody)));
  console.log('  < ' + res.status + ' ' + JSON.stringify(body));
  return { status: res.status, body };
}

function balancesOf(r: ApiResult): Array<{ level: string; used: number; remaining: number }> {
  return r.body.balances as Array<{ level: string; used: number; remaining: number }>;
}

try {
  console.log('\n[1] 层级作用域建模与契约校验');
  check('create global', (await api('POST', '/scopes', { id: 'g', level: 'global', quotaLimit: 100 })).status === 200);
  check('create org', (await api('POST', '/scopes', { id: 'o', level: 'org', parentId: 'g', quotaLimit: 50 })).status === 200);
  check('create project', (await api('POST', '/scopes', { id: 'p', level: 'project', parentId: 'o', quotaLimit: 5 })).status === 200);
  const badParent = await api('POST', '/scopes', { id: 'bad', level: 'project', parentId: 'g', quotaLimit: 1 });
  check('project under global rejected 400/INVALID_REQUEST', badParent.status === 400 && badParent.body.code === 'INVALID_REQUEST');

  console.log('\n[2] 发钥 + 三层联动原子扣减');
  const keyRes = await api('POST', '/keys', { projectScopeId: 'p' });
  check('issue key', keyRes.status === 200 && typeof keyRes.body.secret === 'string');
  const secret = keyRes.body.secret as string;
  const c1 = await api('POST', '/consume', { amount: 3 }, secret);
  check('consume 3 -> 200', c1.status === 200);
  check('all three levels deducted by 3', balancesOf(c1).every((b) => b.used === 3), JSON.stringify(balancesOf(c1)));

  console.log('\n[3] 超限拒绝并整体回滚（无部分扣减）');
  const c2 = await api('POST', '/consume', { amount: 3 }, secret);
  check('over-limit -> 409/QUOTA_EXCEEDED', c2.status === 409 && c2.body.code === 'QUOTA_EXCEEDED');
  const usage1 = await api('GET', '/usage', undefined, secret);
  const proj1 = balancesOf(usage1).find((b) => b.level === 'project');
  check('project balance unchanged after rejection', proj1?.used === 3, JSON.stringify(proj1));
  check('all levels still consistent', balancesOf(usage1).every((b) => b.used === 3));

  console.log('\n[4] 并发消耗后余额守恒（25 并发抢 10 额度）');
  await api('POST', '/scopes', { id: 'g2', level: 'global', quotaLimit: 1000 });
  await api('POST', '/scopes', { id: 'o2', level: 'org', parentId: 'g2', quotaLimit: 1000 });
  await api('POST', '/scopes', { id: 'p2', level: 'project', parentId: 'o2', quotaLimit: 10 });
  const key2 = ((await api('POST', '/keys', { projectScopeId: 'p2' })).body.secret) as string;
  const results = await Promise.all(
    Array.from({ length: 25 }, () =>
      fetch(BASE + '/consume', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key2 },
        body: JSON.stringify({ amount: 1 }),
      }).then((r) => r.status),
    ),
  );
  const okCount = results.filter((s) => s === 200).length;
  const rejectedCount = results.filter((s) => s === 409).length;
  console.log('  > 25 concurrent POST /consume amount=1');
  console.log('  < ok=' + okCount + ' rejected=' + rejectedCount);
  check('exactly 10 consumes succeed', okCount === 10, 'ok=' + okCount);
  check('exactly 15 rejected with 409', rejectedCount === 15, 'rejected=' + rejectedCount);
  const usage2 = await api('GET', '/usage', undefined, key2);
  check('no overshoot: all levels used == 10', balancesOf(usage2).every((b) => b.used === 10), JSON.stringify(balancesOf(usage2)));

  console.log('\n[5] 密钥轮换：宽限期边界');
  const rot = await api('POST', '/keys/rotate', undefined, secret);
  check('rotate -> 200', rot.status === 200);
  const newSecret = (rot.body.newKey as { secret: string }).secret;
  const graceUse = await api('POST', '/consume', { amount: 1 }, secret);
  check('old key usable within grace', graceUse.status === 200);
  console.log('  .. waiting ' + (GRACE_MS + 150) + 'ms for grace to elapse');
  await new Promise((r) => setTimeout(r, GRACE_MS + 150));
  const expiredUse = await api('POST', '/consume', { amount: 1 }, secret);
  check('old key after grace -> 403/KEY_EXPIRED', expiredUse.status === 403 && expiredUse.body.code === 'KEY_EXPIRED');
  const newUse = await api('POST', '/consume', { amount: 1 }, newSecret);
  check('new key works', newUse.status === 200);

  console.log('\n[6] 输入错误与未知密钥可区分');
  const noKey = await api('POST', '/consume', { amount: 1 });
  check('missing key -> 401/KEY_UNKNOWN', noKey.status === 401 && noKey.body.code === 'KEY_UNKNOWN');
  const badAmount = await api('POST', '/consume', { amount: 0 }, newSecret);
  check('invalid amount -> 400/INVALID_REQUEST', badAmount.status === 400 && badAmount.body.code === 'INVALID_REQUEST');

  console.log('\n[7] 诊断日志可重放');
  const logs = await api('GET', '/logs?limit=200');
  const events = (logs.body.entries as Array<{ event: string }>).map((e) => e.event);
  check('logs contain consume/reject/rotate/expire events',
    ['quota.consumed', 'quota.rejected', 'key.rotated', 'key.expired'].every((e) => events.includes(e)),
    events.join(','));
} finally {
  await app.close();
  store.close();
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
  console.log('failed scenarios: ' + failures.join(' | '));
  process.exit(1);
}

