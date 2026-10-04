import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/state/store.ts';
import { createApp } from '../src/server/fastify-lite.ts';
import { registerRoutes } from '../src/server/routes.ts';
import { loadConfig } from '../src/config.ts';

const registry = JSON.parse(readFileSync(new URL('../fixtures/registry.json', import.meta.url), 'utf8'));
const vulns = JSON.parse(readFileSync(new URL('../fixtures/vulnerabilities.json', import.meta.url), 'utf8'));

let app, store;
before(() => {
  store = new Store(':memory:');
  store.seedVulnerabilities(vulns);
  const config = { ...loadConfig(), logDir: mkdtempSync(join(tmpdir(), 'sbom-api-')) };
  app = createApp();
  registerRoutes(app, store, config);
});

test('POST /scans 成功返回 201 与排序后的报告', async () => {
  const res = await app.inject({ method: 'POST', url: '/scans', payload: { scanId: 'api-1', roots: ['app@^1.0.0'], registry } });
  assert.equal(res.status, 201);
  assert.deepEqual(res.payload.findings.map((f) => f.vulnerability.id),
    ['VULN-1001', 'VULN-1003', 'VULN-1004', 'VULN-1005', 'VULN-1007']);
});

test('POST /scans 输入错误 -> 400 INPUT_ERROR', async () => {
  const res = await app.inject({ method: 'POST', url: '/scans', payload: { roots: [], registry } });
  assert.equal(res.status, 400);
  assert.equal(res.payload.error.category, 'INPUT_ERROR');
});

test('POST /scans 状态冲突 -> 409 STATE_CONFLICT', async () => {
  const payload = { scanId: 'api-dup', roots: ['app@^1.0.0'], registry };
  assert.equal((await app.inject({ method: 'POST', url: '/scans', payload })).status, 201);
  const res = await app.inject({ method: 'POST', url: '/scans', payload });
  assert.equal(res.status, 409);
  assert.equal(res.payload.error.category, 'STATE_CONFLICT');
});

test('POST /scans 资源耗尽 -> 413 RESOURCE_EXHAUSTED', async () => {
  const res = await app.inject({ method: 'POST', url: '/scans',
    payload: { roots: ['app@^1.0.0'], registry, options: { maxNodes: 2 } } });
  assert.equal(res.status, 413);
  assert.equal(res.payload.error.category, 'RESOURCE_EXHAUSTED');
});

test('GET /scans/:id 与诊断日志接口', async () => {
  const created = await app.inject({ method: 'POST', url: '/scans', payload: { scanId: 'api-log', roots: ['app@^1.0.0'], registry } });
  const rec = await app.inject({ method: 'GET', url: '/scans/api-log' });
  assert.equal(rec.status, 200);
  assert.equal(rec.payload.status, 'COMPLETED');
  const logs = await app.inject({ method: 'GET', url: '/diagnostics/runs/' + created.payload.runId + '/logs' });
  assert.equal(logs.status, 200);
  assert.ok(logs.payload.events.some((e) => e.event === 'scan.complete'));
  const missing = await app.inject({ method: 'GET', url: '/scans/nope' });
  assert.equal(missing.status, 404);
});
