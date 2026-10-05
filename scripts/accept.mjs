// 一键验收：启动真实 HTTP 服务，按固定顺序演练全部场景。
// 每步打印运行编号、请求、响应、判定理由；全部通过 exit 0，任一失败 exit 1。
import { buildServer } from '../dist/server.js';
import { loadRouteConfigFile } from '../dist/config/loader.js';

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const RUN_ID = `ACCEPT-${new Date().toISOString()}`;
let failures = 0;
let stepNo = 0;

const rules = loadRouteConfigFile('config/routes.demo.json');
const { app } = buildServer({ rules });
await app.listen({ port: PORT, host: '127.0.0.1' });

async function call(method, path, body) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const elapsed = Date.now() - t0;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 文本响应 */ }
  return { status: res.status, headers: res.headers, json, text, elapsed };
}

function step(title, actual, check, reason) {
  stepNo += 1;
  const id = `${RUN_ID}#S${String(stepNo).padStart(2, '0')}`;
  const ok = check();
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${title}`);
  console.log(`    actual: ${JSON.stringify(actual)}`);
  console.log(`    judge : ${reason}`);
  if (!ok) failures += 1;
  return ok;
}

console.log(`run id: ${RUN_ID}`);
console.log(`server: ${BASE}  rules: ${rules.length}`);

try {
  let r = await call('GET', '/api/users/42');
  step('通配符 * 匹配单段', { status: r.status, body: r.json },
    () => r.status === 200 && r.json?.user === 'wildcard',
    '期望 200 且 body.user=wildcard');

  r = await call('GET', '/api/files/a/b/c.txt');
  step('通配符 ** 匹配多段', { status: r.status, body: r.json },
    () => r.status === 200 && r.json?.file === 'deep-wildcard',
    '期望 200 且 body.file=deep-wildcard');

  r = await call('GET', '/api/users/1/2');
  step('通配符 * 不匹配多段', { status: r.status },
    () => r.status === 404,
    '期望 404（无匹配路由）');

  await call('POST', '/__mock/reset');
  const seqs = [];
  for (let i = 0; i < 3; i++) seqs.push(await call('GET', '/api/seq'));
  step('同一 URL 按序号返回不同响应', seqs.map(s => ({ status: s.status, body: s.json })),
    () => seqs[0].json?.attempt === 1 && seqs[1].json?.attempt === 2 && seqs[2].status === 503,
    '期望 attempt=1,2 且第三次 503');

  r = await call('GET', '/api/seq');
  step('序号超出后复用最后一个响应', { status: r.status, seq: r.headers.get('x-mock-sequence') },
    () => r.status === 503 && r.headers.get('x-mock-sequence') === '4',
    '期望 503 且 x-mock-sequence=4');

  r = await call('GET', '/api/slow');
  step('延迟响应计时', { elapsedMs: r.elapsed, status: r.status },
    () => r.status === 200 && r.elapsed >= 280,
    '期望耗时 >=280ms（配置 300ms），实际 ' + r.elapsed + 'ms');

  const vip = await call('POST', '/api/orders', { type: 'vip', item: 'book' });
  r = await call('POST', '/api/orders', { type: 'normal' });
  step('bodyMatch contains 分流', { vip: { status: vip.status, body: vip.json }, normal: { status: r.status, body: r.json } },
    () => vip.status === 201 && vip.json?.order === 'vip-created' && r.status === 200 && r.json?.order === 'normal-created',
    'vip 期望 201/vip-created，普通期望 200/normal-created');

  await call('POST', '/__mock/reset');
  await call('GET', '/api/users/9?debug=1');
  await call('POST', '/api/orders', { type: 'vip' });
  await call('GET', '/unmatched-path');
  r = await call('GET', '/__mock/requests');
  const reqs = r.json?.requests ?? [];
  step('请求记录：顺序/方法/路径/查询/体', reqs.map(q => ({ seq: q.seq, m: q.method, p: q.path })),
    () => reqs.length === 3
      && reqs[0].path === '/api/users/9' && reqs[0].query?.debug === '1'
      && reqs[1].path === '/api/orders' && reqs[1].body?.type === 'vip'
      && reqs[2].path === '/unmatched-path' && reqs[2].matchedRuleId === null,
    '期望 3 条记录按序排列，未匹配也记录且 matchedRuleId=null');

  await call('POST', '/__mock/reset');
  r = await call('GET', '/__mock/requests');
  const afterReset = r.json?.requests?.length;
  r = await call('GET', '/api/seq');
  step('复位清空记录与计数', { recordsAfterReset: afterReset, seqHeader: r.headers.get('x-mock-sequence') },
    () => afterReset === 0 && r.headers.get('x-mock-sequence') === '1',
    '期望记录数=0 且序号重新从 1 开始');

  r = await call('GET', '/no-such-route');
  step('未匹配路由返回 404 NO_MATCH', { status: r.status, body: r.json },
    () => r.status === 404 && r.json?.error?.category === 'NO_MATCH',
    '期望 404 且 error.category=NO_MATCH');
} finally {
  await app.close();
}

console.log(failures === 0 ? ('ALL ' + stepNo + ' STEPS PASSED') : (failures + '/' + stepNo + ' STEPS FAILED'));
process.exit(failures === 0 ? 0 : 1);
