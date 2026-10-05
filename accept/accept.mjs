/**
 * 一键验收脚本：按固定顺序演练全部场景，逐步打印请求/响应/判定。
 * 全部通过退出 0，任一失败退出 1 并指出失败场景。
 */
import { buildServer } from '../dist/server.js';
import { RunStore } from '../dist/store.js';
import { DEFAULT_CONFIG } from '../dist/config.js';

const DIR = 'fixtures/sample';
let failures = 0;
let step = 0;

function verdict(ok, detail) {
  console.log('  判定: ' + (ok ? 'PASS' : 'FAIL') + (detail ? ' - ' + detail : ''));
  if (!ok) failures++;
}

async function scenario(title, fn) {
  step++;
  console.log('\n=== 场景 ' + step + ': ' + title + ' ===');
  try {
    await fn();
  } catch (e) {
    verdict(false, '场景抛异常: ' + (e && e.message));
  }
}

async function post(app, url, payload) {
  console.log('  请求: POST ' + url + ' ' + JSON.stringify(payload));
  const res = await app.inject({ method: 'POST', url, payload });
  console.log('  响应: ' + res.statusCode + ' ' + summarize(res.body));
  return res;
}

async function get(app, url) {
  console.log('  请求: GET ' + url);
  const res = await app.inject({ method: 'GET', url });
  console.log('  响应: ' + res.statusCode + ' ' + summarize(res.body));
  return res;
}

function summarize(body) {
  return body.length > 600 ? body.slice(0, 600) + '...（截断）' : body;
}

const app = buildServer({ ...DEFAULT_CONFIG }, new RunStore(':memory:'));

let firstRunId = null;

await scenario('正常通过的测试全部 passed', async () => {
  const res = await post(app, '/runs', { dir: DIR, pattern: 'pass.test.js' });
  const s = res.json();
  firstRunId = s.runId;
  verdict(
    res.statusCode === 200 && s.status === 'passed' && s.total === 2 && s.passed === 2 &&
      s.failed === 0 && s.timeout === 0 && s.results.every((r) => r.status === 'passed'),
    'status=' + s.status + ' total=' + s.total + ' passed=' + s.passed,
  );
});

await scenario('断言失败与运行时异常被区分并带错误信息', async () => {
  const res = await post(app, '/runs', { dir: DIR, pattern: 'fail.test.js' });
  const s = res.json();
  const byCase = new Map(s.results.map((r) => [r.case, r]));
  const a = byCase.get('断言失败用例');
  const r = byCase.get('运行时异常用例');
  const p = byCase.get('同文件内其他用例不受影响');
  verdict(
    s.status === 'partial' &&
      a && a.status === 'failed' && a.failureKind === 'assertion' && /数学没有崩坏/.test(a.error ?? '') &&
      r && r.status === 'failed' && r.failureKind === 'runtime' && /TypeError/.test(r.error ?? '') &&
      p && p.status === 'passed',
    'assertion=' + (a && a.failureKind) + ' runtime=' + (r && r.failureKind) + ' neighbor=' + (p && p.status),
  );
});

await scenario('超时用例被终止且不阻塞其他用例', async () => {
  const started = Date.now();
  const res = await post(app, '/runs', { dir: DIR, pattern: 'timeout.test.js', timeoutMs: 800 });
  const elapsed = Date.now() - started;
  const s = res.json();
  const byCase = new Map(s.results.map((r) => [r.case, r]));
  const dead = byCase.get('永不结束的用例');
  const neighbor = byCase.get('快速通过的邻居用例');
  verdict(
    dead && dead.status === 'timeout' && dead.failureKind === 'timeout' &&
      dead.durationMs >= 700 && dead.durationMs < 5000 &&
      neighbor && neighbor.status === 'passed' && elapsed < 8000,
    'timeout.durationMs=' + (dead && dead.durationMs) + ' neighbor=' + (neighbor && neighbor.status) +
      ' 整体耗时=' + elapsed + 'ms',
  );
});

await scenario('并行执行互不干扰且比顺序快', async () => {
  const res = await post(app, '/runs', {
    dir: DIR,
    pattern: 'parallel-*.test.js',
    parallel: true,
    concurrency: 2,
  });
  const s = res.json();
  const allPassed = s.results.length === 2 && s.results.every((r) => r.status === 'passed');
  verdict(
    allPassed && s.durationMs < 1500,
    '两个 400ms 用例并行总耗时=' + s.durationMs + 'ms（顺序执行约需 800ms+ 进程开销）',
  );
});

await scenario('错误语义：输入错误/未找到/资源耗尽可区分', async () => {
  const bad1 = await post(app, '/runs', { dir: 'no-such-dir' });
  const bad2 = await post(app, '/runs', {});
  const bad3 = await get(app, '/runs/no-such-run-id');
  const bad4 = await post(app, '/runs', { dir: DIR, concurrency: 999 });
  verdict(
    bad1.statusCode === 400 && bad1.json().error.code === 'INVALID_INPUT' &&
      bad2.statusCode === 400 && bad2.json().error.code === 'INVALID_INPUT' &&
      bad3.statusCode === 404 && bad3.json().error.code === 'NOT_FOUND' &&
      bad4.statusCode === 429 && bad4.json().error.code === 'RESOURCE_EXHAUSTED',
    '400/400/404/429 错误码分别为 ' +
      [bad1, bad2, bad3, bad4].map((r) => r.json().error.code).join(', '),
  );
});

await scenario('历史结果可按文件名与时间查询', async () => {
  const byFile = await get(app, '/runs?file=pass.test.js');
  const byTime = await get(app, '/runs?from=' + new Date(Date.now() - 3600e3).toISOString());
  const detail = await get(app, '/runs/' + firstRunId);
  verdict(
    byFile.json().runs.some((r) => r.runId === firstRunId) &&
      byTime.json().runs.length >= 4 &&
      detail.json().runId === firstRunId && detail.json().logs.length > 0,
    '按文件命中=' + byFile.json().runs.length + ' 按时间命中=' + byTime.json().runs.length +
      ' 日志条数=' + detail.json().logs.length,
  );
});

await app.close();

console.log('\n========================================');
if (failures > 0) {
  console.log('验收失败: ' + failures + ' 个判定未通过');
  process.exit(1);
}
console.log('验收通过: 全部 ' + step + ' 个场景符合预期');
process.exit(0);