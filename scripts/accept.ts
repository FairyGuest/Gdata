// 一键验收：按固定顺序演练全部场景，逐步打印请求/响应/判定。
// 全部通过退出 0；任一失败退出 1 并列出失败场景。
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/state/store.ts';
import { createApp } from '../src/server/fastify-lite.ts';
import { registerRoutes } from '../src/server/routes.ts';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const registry = read('../fixtures/registry.json');
const vulns = read('../fixtures/vulnerabilities.json');

const config = { ...loadConfig(), dbPath: join(mkdtempSync(join(tmpdir(), 'sbom-accept-')), 'accept.sqlite') };
const store = new Store(config.dbPath);
store.seedVulnerabilities(vulns);
const app = createApp();
registerRoutes(app, store, config);
const server = await app.listen(0, '127.0.0.1');
const baseUrl = 'http://127.0.0.1:' + server.address().port;

const results = [];
async function scenario(name, fn) {
  console.log('\n=== 场景: ' + name + ' ===');
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('判定: PASS');
  } catch (e) {
    results.push({ name, ok: false, reason: e.message });
    console.log('判定: FAIL - ' + e.message);
  }
}
function check(cond, msg) { if (!cond) throw new Error('断言失败: ' + msg); }
async function post(path, payload) {
  console.log('请求: POST ' + path + ' ' + JSON.stringify({ ...payload, registry: '[...' + (payload.registry?.length ?? 0) + ' packages]' }));
  const res = await fetch(baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await res.json();
  console.log('响应: ' + res.status + ' ' + JSON.stringify(body).slice(0, 600));
  return { status: res.status, body };
}
async function get(path) {
  console.log('请求: GET ' + path);
  const res = await fetch(baseUrl + path);
  const body = await res.json();
  console.log('响应: ' + res.status + ' ' + JSON.stringify(body).slice(0, 600));
  return { status: res.status, body };
}

let mainReport;
await scenario('1. 深层传递依赖漏洞（6 层传递链上的 lib-e 必须报出）', async () => {
  const { status, body } = await post('/scans', { scanId: 'accept-main', roots: ['app@^1.0.0'], registry });
  check(status === 201, '期望 201，实际 ' + status);
  mainReport = body;
  check(body.packageCount === 9, '期望 9 个包，实际 ' + body.packageCount);
  const deep = body.findings.find((f) => f.vulnerability.id === 'VULN-1001');
  check(!!deep, '缺少深层传递漏洞 VULN-1001');
  check(deep.paths[0].join('>') === 'app@1.0.0>lib-a@1.2.0>lib-b@1.1.0>lib-c@3.0.5>lib-d@1.4.2>lib-e@2.1.5',
    '依赖路径不正确: ' + JSON.stringify(deep.paths));
});

await scenario('2. 版本边界恰好包含（<=2.1.5 命中解析出的 2.1.5）', async () => {
  const hit = mainReport.findings.find((f) => f.vulnerability.id === 'VULN-1001');
  check(!!hit && hit.packageVersion === '2.1.5', 'VULN-1001 应命中 lib-e@2.1.5');
});

await scenario('3. 版本边界恰好不包含（<2.1.5 与 <1.10.0 不得命中）', async () => {
  const ids = mainReport.findings.map((f) => f.vulnerability.id);
  check(!ids.includes('VULN-1002'), 'VULN-1002 上界恰好排除，不应出现');
  check(!ids.includes('VULN-1006'), 'VULN-1006 上界 1.10.0 恰好排除（防字典序比较），不应出现');
});

await scenario('4. 循环依赖（循环边记录但不展开，扫描正常完成）', async () => {
  check(mainReport.cycles.length === 1, '期望 1 条循环边，实际 ' + mainReport.cycles.length);
  check(mainReport.cycles[0].from === 'util-right@1.3.0' && mainReport.cycles[0].to === 'util-left@2.0.1',
    '循环边内容不正确: ' + JSON.stringify(mainReport.cycles));
  check(mainReport.findings.some((f) => f.vulnerability.id === 'VULN-1007'), '循环分支上的漏洞 VULN-1007 必须报出');
});

await scenario('5. 严重度排序（CRITICAL > HIGH > MEDIUM > LOW）', async () => {
  const order = mainReport.findings.map((f) => f.vulnerability.severity).join(',');
  check(order === 'CRITICAL,HIGH,MEDIUM,LOW,LOW', '排序不正确: ' + order);
});

await scenario('6. 输入错误可区分（400 INPUT_ERROR）', async () => {
  const { status, body } = await post('/scans', { roots: [], registry });
  check(status === 400 && body.error.category === 'INPUT_ERROR', '期望 400/INPUT_ERROR，实际 ' + status + '/' + body.error?.category);
});

await scenario('7. 状态冲突可区分（409 STATE_CONFLICT，重复 scanId）', async () => {
  const { status, body } = await post('/scans', { scanId: 'accept-main', roots: ['app@^1.0.0'], registry });
  check(status === 409 && body.error.category === 'STATE_CONFLICT', '期望 409/STATE_CONFLICT，实际 ' + status + '/' + body.error?.category);
});

await scenario('8. 资源耗尽可区分（413 RESOURCE_EXHAUSTED）', async () => {
  const { status, body } = await post('/scans', { roots: ['app@^1.0.0'], registry, options: { maxNodes: 2 } });
  check(status === 413 && body.error.category === 'RESOURCE_EXHAUSTED', '期望 413/RESOURCE_EXHAUSTED，实际 ' + status + '/' + body.error?.category);
});

await scenario('9. 诊断日志可重放（runId 串联关键中间状态）', async () => {
  const { status, body } = await get('/diagnostics/runs/' + mainReport.runId + '/logs');
  check(status === 200, '期望 200，实际 ' + status);
  const events = body.events.map((e) => e.event);
  for (const ev of ['scan.start', 'graph.resolved', 'cycle.detected', 'match.found', 'scan.complete']) {
    check(events.includes(ev), '日志缺少事件 ' + ev);
  }
  check(body.events.every((e) => e.runId === mainReport.runId), '日志 runId 不一致');
});

server.close();
const failed = results.filter((r) => !r.ok);
console.log('\n========== 验收汇总 ==========');
for (const r of results) console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + (r.ok ? '' : '  (' + r.reason + ')'));
if (failed.length > 0) {
  console.log('\n验收失败，未通过场景: ' + failed.map((f) => f.name).join('; '));
  process.exit(1);
}
console.log('\n全部 ' + results.length + ' 个场景通过。');
process.exit(0);
