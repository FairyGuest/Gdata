/**
 * 一键验收：npm run accept
 * 按固定顺序演练全部场景，逐步打印请求/响应/判定。
 * 全部通过退出 0；任一失败非 0 退出并指出失败场景。
 * 日志带运行编号（runId）与关键中间状态，可据此重放问题。
 */
import { MockEngine } from '../src/core/engine.ts';
import { RequestRecorder } from '../src/state/recorder.ts';
import { parseRoutes } from '../src/config/loader.ts';
import { startMockServer } from '../src/adapters/http.ts';

const runId = 'accept-' + Date.now().toString(36);
let failures = 0;
let step = 0;

function log(...args: unknown[]) { console.log(`[${runId}]`, ...args); }

function check(name: string, ok: boolean, reason: string): void {
  step++;
  log(`  判定[${name}]: ${ok ? 'PASS' : 'FAIL'} — ${reason}`);
  if (!ok) failures++;
}

// 独立验收配置：不由被测核心生成，作为外部参考答案
const acceptRoutes = parseRoutes([
  {
    id: 'wild-user', method: 'GET', path: '/api/users/*',
    responses: [
      { status: 200, headers: { 'x-mock': 'first' }, body: { attempt: 1 } },
      { status: 200, headers: { 'x-mock': 'second' }, body: { attempt: 2 } },
      { status: 503, body: { attempt: 3, note: 'upstream down' } },
    ],
  },
  {
    id: 'wild-deep', method: 'GET', path: '/api/files/**',
    responses: [{ status: 200, body: { file: 'any' } }],
    onExhausted: 'repeat-last',
  },
  {
    id: 'slow', method: 'GET', path: '/api/slow',
    responses: [{ status: 200, delayMs: 250, body: { slow: true } }],
  },
  {
    id: 'order', method: 'POST', path: '/api/orders',
    bodyMatch: { json: { sku: 'A-1' } },
    responses: [{ status: 201, body: { orderId: 'ord-1' } }],
  },
]);

const engine = new MockEngine(acceptRoutes);
const recorder = new RequestRecorder();
const { port, close } = await startMockServer({ engine, recorder, port: 0 });
const base = `http://127.0.0.1:${port}`;
log(`服务器已启动: ${base}，路由 ${acceptRoutes.length} 条`);

try {
  // 场景 1：通配符路由匹配
  log('场景1: 通配符路由匹配（* 与 **）');
  const w1 = await fetch(`${base}/api/users/42`);
  const w1body = await w1.json();
  log(`  GET /api/users/42 -> ${w1.status}`, JSON.stringify(w1body));
  check('wildcard-*', w1.status === 200 && w1body.attempt === 1,
    `期望 200/attempt=1，实际 ${w1.status}/${JSON.stringify(w1body)}`);
  const w2 = await fetch(`${base}/api/files/a/b/c.txt`);
  log(`  GET /api/files/a/b/c.txt -> ${w2.status}`);
  check('wildcard-**', w2.status === 200, `期望 ** 跨段命中 200，实际 ${w2.status}`);
  const w3 = await fetch(`${base}/api/users/1/orders`);
  const w3body = await w3.json();
  log(`  GET /api/users/1/orders -> ${w3.status}`, JSON.stringify(w3body));
  check('wildcard-no-cross', w3.status === 404 && w3body.error.category === 'NO_MATCH',
    `* 不应跨段，期望 404/NO_MATCH，实际 ${w3.status}/${w3body.error?.category}`);

  // 场景 2：同一路由按序号返回不同响应
  log('场景2: 按调用序号返回不同响应');
  const s2 = await fetch(`${base}/api/users/42`);
  const s3 = await fetch(`${base}/api/users/42`);
  log(`  第2次 -> ${s2.status} x-mock=${s2.headers.get('x-mock')}；第3次 -> ${s3.status}`);
  check('sequence-2nd', s2.headers.get('x-mock') === 'second',
    `第2次期望 x-mock=second，实际 ${s2.headers.get('x-mock')}`);
  check('sequence-3rd', s3.status === 503, `第3次期望 503，实际 ${s3.status}`);
  const s4 = await fetch(`${base}/api/users/42`);
  const s4body = await s4.json();
  log(`  第4次(耗尽) -> ${s4.status}`, JSON.stringify(s4body));
  check('sequence-exhausted', s4.status === 500 && s4body.error.code === 'SEQUENCE_EXHAUSTED'
    && s4body.error.category === 'STATE_CONFLICT',
    `耗尽期望 500/SEQUENCE_EXHAUSTED/STATE_CONFLICT，实际 ${s4.status}/${s4body.error?.code}`);

  // 场景 3：延迟响应计时
  log('场景3: 延迟响应计时（delayMs=250）');
  const t0 = performance.now();
  const d1 = await fetch(`${base}/api/slow`);
  const elapsed = performance.now() - t0;
  log(`  GET /api/slow -> ${d1.status}，耗时 ${elapsed.toFixed(1)}ms`);
  check('delay-timing', d1.status === 200 && elapsed >= 240,
    `期望耗时>=240ms，实际 ${elapsed.toFixed(1)}ms`);

  // 场景 4：请求体匹配
  log('场景4: 请求体匹配（bodyMatch.json）');
  const b1 = await fetch(`${base}/api/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'A-1', qty: 2 }),
  });
  const b2 = await fetch(`${base}/api/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'B-9' }),
  });
  const b2body = await b2.json();
  log(`  sku=A-1 -> ${b1.status}；sku=B-9 -> ${b2.status}`);
  check('body-match-hit', b1.status === 201, `期望命中 201，实际 ${b1.status}`);
  check('body-match-miss', b2.status === 404 && b2body.error.category === 'NO_MATCH',
    `期望未命中 404/NO_MATCH，实际 ${b2.status}`);

  // 场景 5：请求记录与调用顺序
  log('场景5: 请求记录与调用顺序验证');
  const recs = (await (await fetch(`${base}/__requests`)).json()).requests;
  const seqs = recs.map((r: { seq: number }) => r.seq);
  const ordered = seqs.every((v: number, i: number) => i === 0 || v > seqs[i - 1]);
  const paths = recs.map((r: { path: string }) => r.path);
  log(`  记录 ${recs.length} 条，路径序列:`, paths.join(' | '));
  check('record-order', ordered && paths[0] === '/api/users/42' && paths[1] === '/api/files/a/b/c.txt',
    `seq 应严格递增且前两条为 users/files，实际 ${paths.slice(0, 2).join(',')}`);
  const orderRec = recs.find((r: { matched: boolean; path: string }) => r.matched && r.path === '/api/orders');
  check('record-params', !!orderRec && JSON.parse(orderRec.body).sku === 'A-1' && orderRec.routeId === 'order',
    `订单记录应含 sku=A-1 与 routeId=order，实际 ${orderRec ? JSON.stringify(orderRec.body) : '缺失'}`);
  const verify = await (await fetch(`${base}/__verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'GET', path: '/api/users/42', times: 4 }),
  })).json();
  log(`  /__verify users/42 times=4 ->`, JSON.stringify(verify));
  check('verify-api', verify.ok === true && verify.actual === 4,
    `期望 ok/actual=4，实际 ${JSON.stringify(verify)}`);

  // 场景 6：重置
  log('场景6: 重置清空记录与调用计数');
  await fetch(`${base}/__reset`, { method: 'POST' });
  const afterReset = (await (await fetch(`${base}/__requests`)).json()).requests;
  const again = await fetch(`${base}/api/users/42`);
  log(`  reset 后记录数=${afterReset.length}；再次调用 x-mock=${again.headers.get('x-mock')}`);
  check('reset-records', afterReset.length === 0, `期望记录清空，实际 ${afterReset.length} 条`);
  check('reset-counters', again.headers.get('x-mock') === 'first',
    `期望计数归零回到 first，实际 ${again.headers.get('x-mock')}`);

  // 场景 7：错误类别可区分
  log('场景7: 错误类别可区分（INPUT_ERROR / NO_MATCH）');
  const e1 = await fetch(`${base}/__verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const e1body = await e1.json();
  const e2 = await fetch(`${base}/no/such/route`);
  const e2body = await e2.json();
  log(`  非法 verify -> ${e1.status}/${e1body.error.category}；未知路由 -> ${e2.status}/${e2body.error.category}`);
  check('error-input', e1.status === 400 && e1body.error.category === 'INPUT_ERROR',
    `期望 400/INPUT_ERROR，实际 ${e1.status}/${e1body.error?.category}`);
  check('error-no-match', e2.status === 404 && e2body.error.category === 'NO_MATCH',
    `期望 404/NO_MATCH，实际 ${e2.status}/${e2body.error?.category}`);
} finally {
  await close();
  recorder.close();
}

log(`验收完成: 共 ${step} 项判定，失败 ${failures} 项`);
if (failures > 0) {
  console.error(`[${runId}] 验收失败: ${failures} 项未通过`);
  process.exit(1);
}
log('全部场景通过，退出 0');
