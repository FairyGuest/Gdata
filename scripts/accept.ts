// One-shot acceptance drill. Runs the unit test suite (in-process) and then
// a fixed-order sequence of end-to-end scenarios against a real HTTP server.
// Every step prints request, response and verdict. Exit 0 iff all pass.
import { run as runTests } from 'node:test';
import { readFileSync, rmSync } from 'node:fs';
import { Store } from '../src/state/store.ts';
import { ScanEngine } from '../src/core/engine.ts';
import { buildServer } from '../src/api/server.ts';

let failures = 0;
const results = [];

function verdict(name, ok, reason) {
  const mark = ok ? 'PASS' : 'FAIL';
  console.log('  VERDICT: ' + mark + (ok ? '' : ' -- ' + reason));
  results.push({ name, ok, reason });
  if (!ok) failures++;
  console.log('');
}

function showRequest(method, path, body) {
  console.log('  REQUEST:  ' + method + ' ' + path + (body ? ' body=' + JSON.stringify(body).slice(0, 160) : ''));
}

function showResponse(status, body) {
  const s = JSON.stringify(body);
  console.log('  RESPONSE: ' + status + ' ' + (s.length > 400 ? s.slice(0, 400) + '...' : s));
}

async function stepUnitTests() {
  console.log('=== STEP 1: unit test suite (node:test, in-process) ===');
  const files = ['test/semver.test.ts', 'test/graph.test.ts', 'test/engine.test.ts', 'test/api.test.ts'];
  const stream = runTests({ files, isolation: 'none' });
  let pass = 0, fail = 0;
  for await (const event of stream) {
    if (event.type === 'test:pass') pass++;
    if (event.type === 'test:fail') {
      fail++;
      console.log('  FAIL: ' + event.data.name);
    }
  }
  console.log('  unit tests: pass=' + pass + ' fail=' + fail);
  verdict('unit-tests', fail === 0 && pass > 0, fail + ' failing unit tests');
}

const fixture = (n) => JSON.parse(readFileSync('fixtures/' + n, 'utf8'));

let base;      // main server base URL
let baseSmall; // server with tiny resource limits
let store;
let storeSmall;

async function req(method, path, body, small = false) {
  const url = (small ? baseSmall : base) + path;
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function main() {
  await stepUnitTests();

  rmSync('data/accept.db', { force: true });
  store = new Store('data/accept.db');
  store.loadVulnDb('fixtures/vuln-db.json');
  const app = buildServer(new ScanEngine(store, { maxPackages: 1000, maxDepth: 32 }), store);
  base = await app.listen({ port: 0, host: '127.0.0.1' });

  storeSmall = new Store(':memory:');
  storeSmall.loadVulnDb('fixtures/vuln-db.json');
  const appSmall = buildServer(new ScanEngine(storeSmall, { maxPackages: 1000, maxDepth: 2 }), storeSmall);
  baseSmall = await appSmall.listen({ port: 0, host: '127.0.0.1' });
  console.log('  server: ' + base + ' (limits: maxDepth=32) / ' + baseSmall + ' (limits: maxDepth=2)');
  console.log('');

  // STEP 2: health
  console.log('=== STEP 2: health check ===');
  {
    showRequest('GET', '/health');
    const r = await req('GET', '/health');
    showResponse(r.status, r.json);
    verdict('health', r.status === 200 && r.json.status === 'ok' && r.json.vulnerabilities === 8,
      'expected 200 ok with 8 vuln entries');
  }

  // STEP 3: deep transitive scan
  let deepReport;
  console.log('=== STEP 3: deep transitive dependency scan ===');
  {
    const body = fixture('sbom-deep.json');
    showRequest('POST', '/scan', body);
    const r = await req('POST', '/scan', body);
    deepReport = r.json;
    showResponse(r.status, r.json);
    const ids = r.json.findings?.map((f) => f.vulnId) ?? [];
    const deep = r.json.findings?.find((f) => f.vulnId === 'VULN-001');
    const expectedPath = ['app@1.0.0', 'lib-a@1.0.0', 'lib-b@1.0.0', 'lib-c@1.0.0', 'lib-d@1.0.0', 'lib-deep@1.4.0'];
    const ok = r.status === 200
      && r.json.stats.packagesScanned === 10
      && r.json.stats.maxDepth === 5
      && ['VULN-001', 'VULN-002', 'VULN-003', 'VULN-004'].every((v) => ids.includes(v))
      && JSON.stringify(deep?.dependencyPath) === JSON.stringify(expectedPath);
    verdict('deep-transitive', ok, 'findings=' + ids.join(',') + ' path=' + JSON.stringify(deep?.dependencyPath));
  }

  // STEP 4: version boundary - exactly included
  console.log('=== STEP 4: version boundary (exactly included) ===');
  {
    const hit = deepReport.findings.find((f) => f.vulnId === 'VULN-003');
    console.log('  CHECK:    lib-edge@1.2.0 vs range ">=1.0.0 <=1.2.0" (inclusive upper bound)');
    verdict('boundary-included', Boolean(hit) && hit.version === '1.2.0',
      'VULN-003 must match lib-edge 1.2.0 exactly on the boundary');
  }

  // STEP 5: version boundary - exactly excluded
  console.log('=== STEP 5: version boundary (exactly excluded) ===');
  {
    const body = fixture('sbom-boundary-excluded.json');
    showRequest('POST', '/scan', body);
    const r = await req('POST', '/scan', body);
    showResponse(r.status, r.json);
    verdict('boundary-excluded', r.status === 200 && r.json.findings.length === 0,
      'lib-edge 1.2.1 is one patch above <=1.2.0 and must produce zero findings');
  }

  // STEP 6: cycle handling
  console.log('=== STEP 6: cyclic dependency handling ===');
  {
    console.log('  CHECK:    cycles recorded but not expanded; scan terminates');
    const ok = deepReport.stats.cyclesDetected === 1
      && deepReport.cycles.length === 1
      && deepReport.cycles[0].from === 'lib-cycle2@1.0.0'
      && deepReport.cycles[0].to === 'lib-cycle@1.0.0'
      && deepReport.status === 'completed';
    verdict('cycle-handling', ok, 'cycles=' + JSON.stringify(deepReport.cycles));
  }

  // STEP 7: severity ordering
  console.log('=== STEP 7: severity ordering (critical > high > medium) ===');
  {
    const body = fixture('sbom-ordering.json');
    showRequest('POST', '/scan', body);
    const r = await req('POST', '/scan', body);
    showResponse(r.status, r.json);
    const order = r.json.findings?.map((f) => f.severity) ?? [];
    const ok = r.status === 200 && JSON.stringify(order) === JSON.stringify(['critical', 'high', 'medium']);
    verdict('severity-ordering', ok, 'order=' + order.join(','));
  }

  // STEP 8: input error
  console.log('=== STEP 8: input error semantics (400 INPUT_ERROR) ===');
  {
    const bad = { root: 'app@1.0.0', packages: [{ name: 'app', version: '1.0' }] };
    showRequest('POST', '/scan', bad);
    const r = await req('POST', '/scan', bad);
    showResponse(r.status, r.json);
    verdict('input-error', r.status === 400 && r.json.error?.category === 'INPUT_ERROR',
      'expected 400 INPUT_ERROR, got ' + r.status);
  }

  // STEP 9: idempotency replay + state conflict
  console.log('=== STEP 9: idempotent replay and state conflict (409) ===');
  {
    const body = fixture('sbom-boundary-excluded.json');
    body.idempotencyKey = 'accept-key-1';
    showRequest('POST', '/scan', body);
    const first = await req('POST', '/scan', body);
    const replay = await req('POST', '/scan', body);
    const changed = fixture('sbom-boundary-excluded.json');
    changed.idempotencyKey = 'accept-key-1';
    changed.packages[1].version = '9.9.9';
    changed.packages[0].dependencies['lib-edge'] = '9.9.9';
    showRequest('POST', '/scan', changed);
    const conflict = await req('POST', '/scan', changed);
    showResponse(conflict.status, conflict.json);
    const ok = first.status === 200
      && replay.json.runId === first.json.runId
      && conflict.status === 409
      && conflict.json.error?.category === 'STATE_CONFLICT';
    verdict('state-conflict', ok, 'replay runId match=' + (replay.json.runId === first.json.runId)
      + ', conflict status=' + conflict.status);
  }

  // STEP 10: resource exhaustion
  console.log('=== STEP 10: resource exhaustion (413 RESOURCE_EXHAUSTED) ===');
  {
    const body = fixture('sbom-deep.json');
    delete body.idempotencyKey;
    showRequest('POST', '/scan (maxDepth=2 server)', body);
    const r = await req('POST', '/scan', body, true);
    showResponse(r.status, r.json);
    verdict('resource-exhausted', r.status === 413 && r.json.error?.category === 'RESOURCE_EXHAUSTED',
      'expected 413 RESOURCE_EXHAUSTED, got ' + r.status);
  }

  // STEP 11: diagnostics replay
  console.log('=== STEP 11: diagnostics log replay ===');
  {
    showRequest('GET', '/diagnostics/runs/' + deepReport.runId + '/logs');
    const r = await req('GET', '/diagnostics/runs/' + deepReport.runId + '/logs');
    const steps = new Set((r.json.events ?? []).map((e) => e.step));
    showResponse(r.status, { runId: r.json.runId, eventCount: r.json.events?.length, steps: [...steps] });
    const ok = r.status === 200
      && ['contract', 'graph', 'expand', 'cycle', 'match', 'done'].every((s) => steps.has(s));
    verdict('diagnostics-replay', ok, 'missing steps in run log');
  }

  await app.close();
  await appSmall.close();
  store.close();
  storeSmall.close();

  console.log('=== SUMMARY ===');
  for (const r of results) console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + (r.ok ? '' : ' -- ' + r.reason));
  if (failures > 0) {
    console.log('ACCEPTANCE FAILED: ' + failures + ' scenario(s) failed');
    process.exit(1);
  }
  console.log('ACCEPTANCE PASSED: all ' + results.length + ' scenarios green');
  process.exit(0);
}

main().catch((err) => {
  console.error('ACCEPTANCE ERROR (unexpected):', err);
  process.exit(1);
});
