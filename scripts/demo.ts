// Local demo: boots the service on an ephemeral port, scans the deep
// fixture, prints the report and a diagnostics excerpt, then shuts down.
import { readFileSync } from 'node:fs';
import { Store } from '../src/state/store.ts';
import { ScanEngine } from '../src/core/engine.ts';
import { buildServer } from '../src/api/server.ts';

const store = new Store(':memory:');
const n = store.loadVulnDb('fixtures/vuln-db.json');
const engine = new ScanEngine(store, { maxPackages: 1000, maxDepth: 32 });
const app = buildServer(engine, store);
const base = await app.listen({ port: 0, host: '127.0.0.1' });
console.log('demo server: ' + base + ' (' + n + ' vuln entries loaded)');

const body = JSON.parse(readFileSync('fixtures/sbom-deep.json', 'utf8'));
const res = await fetch(base + '/scan', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const report = await res.json();
console.log('\nscan status: ' + res.status + ' runId=' + report.runId);
console.log('stats: ' + JSON.stringify(report.stats));
console.log('cycles: ' + JSON.stringify(report.cycles));
console.log('\nfindings (severity-sorted):');
for (const f of report.findings) {
  console.log('  [' + f.severity.toUpperCase().padEnd(8) + '] ' + f.vulnId + ' ' + f.package + '@' + f.version);
  console.log('             ' + f.summary);
  console.log('             path: ' + f.dependencyPath.join(' -> '));
}

const logs = await (await fetch(base + '/diagnostics/runs/' + report.runId + '/logs')).json();
console.log('\ndiagnostics excerpt (first 6 events):');
for (const e of logs.events.slice(0, 6)) {
  console.log('  #' + e.seq + ' [' + e.step + '] ' + e.detail);
}
await app.close();
store.close();
