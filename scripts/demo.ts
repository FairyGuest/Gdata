// 本地演示：启动服务 -> 发送真实 HTTP 扫描请求 -> 打印报告。
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
const scanReq = read('../fixtures/scan-request.json');

const config = { ...loadConfig(), port: 0, dbPath: join(mkdtempSync(join(tmpdir(), 'sbom-demo-')), 'demo.sqlite') };
const store = new Store(config.dbPath);
store.seedVulnerabilities(vulns);
const app = createApp();
registerRoutes(app, store, config);
const server = await app.listen(0, '127.0.0.1');
const addr = server.address();
const baseUrl = `http://127.0.0.1:${addr.port}`;
console.log('[demo] server at', baseUrl);

const payload = { ...scanReq, registry };
console.log('[demo] POST /scans  roots=' + JSON.stringify(payload.roots));
const res = await fetch(baseUrl + '/scans', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});
const report = await res.json();
console.log('[demo] status', res.status, ' runId', report.runId);
console.log('[demo] packages:', report.packageCount, ' cycles:', JSON.stringify(report.cycles));
for (const f of report.findings) {
  console.log(`[demo] [${f.vulnerability.severity}] ${f.vulnerability.id} ${f.packageName}@${f.packageVersion} - ${f.vulnerability.summary}`);
  for (const p of f.paths) console.log('[demo]   path: ' + p.join(' -> '));
}
const logs = await (await fetch(baseUrl + '/diagnostics/runs/' + report.runId + '/logs')).json();
console.log('[demo] diagnostic events:', logs.events.map((e) => e.event).join(', '));
server.close();
