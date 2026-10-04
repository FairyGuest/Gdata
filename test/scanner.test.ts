import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/state/store.ts';
import { runScan } from '../src/core/scanner.ts';
import { loadConfig } from '../src/config.ts';

const registry = JSON.parse(readFileSync(new URL('../fixtures/registry.json', import.meta.url), 'utf8'));
const vulns = JSON.parse(readFileSync(new URL('../fixtures/vulnerabilities.json', import.meta.url), 'utf8'));

let store, config;
before(() => {
  store = new Store(':memory:');
  config = { ...loadConfig(), logDir: mkdtempSync(join(tmpdir(), 'sbom-test-')) };
  store.seedVulnerabilities(vulns);
});

test('完整扫描：传递依赖漏洞全部报出，按严重度排序，附依赖路径', () => {
  const report = runScan({ scanId: 't-full', roots: ['app@^1.0.0'], registry }, store, config);
  assert.equal(report.packageCount, 9);
  // 参考答案（硬编码，非由被测实现生成）：
  assert.deepEqual(report.findings.map((f) => f.vulnerability.id),
    ['VULN-1001', 'VULN-1003', 'VULN-1004', 'VULN-1005', 'VULN-1007']);
  assert.deepEqual(report.findings.map((f) => f.vulnerability.severity),
    ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'LOW']);
  // 恰好不包含的边界不得出现
  const ids = report.findings.map((f) => f.vulnerability.id);
  assert.ok(!ids.includes('VULN-1002'), 'VULN-1002 边界恰好排除 2.1.5，不应命中');
  assert.ok(!ids.includes('VULN-1006'), 'VULN-1006 上界 1.10.0 恰好排除，不应命中');
  // 深层传递漏洞的依赖路径
  const deep = report.findings.find((f) => f.vulnerability.id === 'VULN-1001');
  assert.deepEqual(deep.paths[0], ['app@1.0.0','lib-a@1.2.0','lib-b@1.1.0','lib-c@3.0.5','lib-d@1.4.2','lib-e@2.1.5']);
  // 循环边
  assert.deepEqual(report.cycles, [{ from: 'util-right@1.3.0', to: 'util-left@2.0.1' }]);
  // 报告持久化可取回
  const rec = store.getScan('t-full');
  assert.equal(rec.status, 'COMPLETED');
  assert.equal(rec.report.findings.length, 5);
});

test('状态冲突：重复 scanId 报 STATE_CONFLICT', () => {
  runScan({ scanId: 't-dup', roots: ['app@^1.0.0'], registry }, store, config);
  assert.throws(() => runScan({ scanId: 't-dup', roots: ['app@^1.0.0'], registry }, store, config),
    (e) => e.category === 'STATE_CONFLICT');
});

test('输入错误：缺 roots / 非法版本', () => {
  assert.throws(() => runScan({ roots: [], registry }, store, config), (e) => e.category === 'INPUT_ERROR');
  assert.throws(() => runScan({ roots: ['app@^1.0.0'], registry: [{ name: 'x', version: 'abc' }] }, store, config),
    (e) => e.category === 'INPUT_ERROR');
});

test('资源耗尽：maxNodes 过小报 RESOURCE_EXHAUSTED 且记录 FAILED', () => {
  assert.throws(
    () => runScan({ scanId: 't-oom', roots: ['app@^1.0.0'], registry, options: { maxNodes: 2 } }, store, config),
    (e) => e.category === 'RESOURCE_EXHAUSTED');
  assert.equal(store.getScan('t-oom').status, 'FAILED');
});

test('诊断日志：runId 串联关键中间状态与判断理由', () => {
  const report = runScan({ scanId: 't-log', roots: ['app@^1.0.0'], registry }, store, config);
  const events = store.getRunLogs(report.runId).map((e) => e.event);
  for (const ev of ['scan.received', 'scan.start', 'graph.resolved', 'cycle.detected', 'match.found', 'scan.complete']) {
    assert.ok(events.includes(ev), 'missing log event ' + ev);
  }
  const cycleLog = store.getRunLogs(report.runId).find((e) => e.event === 'cycle.detected');
  assert.equal(cycleLog.data.reason, 'cycle edge recorded, not expanded');
});
