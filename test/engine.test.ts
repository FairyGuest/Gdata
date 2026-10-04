import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../src/state/store.ts';
import { ScanEngine } from '../src/core/engine.ts';
import { ScanError } from '../src/contract/errors.ts';

const LIMITS = { maxPackages: 1000, maxDepth: 32 };

function makeEngine() {
  const store = new Store(':memory:');
  store.loadVulnDb('fixtures/vuln-db.json');
  return { store, engine: new ScanEngine(store, LIMITS) };
}

function loadFixture(name) {
  return JSON.parse(readFileSync('fixtures/' + name, 'utf8'));
}

test('deep transitive scan finds vulnerabilities at every level with dependency paths', () => {
  const { engine } = makeEngine();
  const report = engine.run(loadFixture('sbom-deep.json'));
  assert.equal(report.status, 'completed');
  assert.equal(report.stats.packagesScanned, 10);
  assert.equal(report.stats.maxDepth, 5);

  const byVuln = new Map(report.findings.map((f) => [f.vulnId, f]));
  const deep = byVuln.get('VULN-001');
  assert.ok(deep, 'VULN-001 (lib-deep, transitive depth 5) must be found');
  assert.equal(deep.severity, 'critical');
  assert.deepEqual(deep.dependencyPath,
    ['app@1.0.0', 'lib-a@1.0.0', 'lib-b@1.0.0', 'lib-c@1.0.0', 'lib-d@1.0.0', 'lib-deep@1.4.0']);
  assert.ok(byVuln.get('VULN-002'), 'VULN-002 (lib-mid) must be found');
  assert.ok(byVuln.get('VULN-003'), 'VULN-003 boundary version 1.2.0 must be included');
  assert.ok(byVuln.get('VULN-004'), 'VULN-004 (lib-cycle) must be found');
  assert.deepEqual(report.cycles, [{ from: 'lib-cycle2@1.0.0', to: 'lib-cycle@1.0.0' }]);
  assert.equal(report.stats.cyclesDetected, 1);
});

test('boundary version just outside the range is NOT reported', () => {
  const { engine } = makeEngine();
  const report = engine.run(loadFixture('sbom-boundary-excluded.json'));
  assert.equal(report.status, 'completed');
  assert.equal(report.findings.length, 0, 'lib-edge 1.2.1 is one patch above <=1.2.0 and must be excluded');
});

test('findings are sorted by severity (critical > high > medium > low)', () => {
  const { engine } = makeEngine();
  const report = engine.run(loadFixture('sbom-ordering.json'));
  assert.deepEqual(report.findings.map((f) => f.vulnId), ['VULN-007', 'VULN-008', 'VULN-006']);
  assert.deepEqual(report.findings.map((f) => f.severity), ['critical', 'high', 'medium']);
});

test('idempotency: identical replay returns the stored run; different payload conflicts', () => {
  const { engine } = makeEngine();
  const body = loadFixture('sbom-boundary-excluded.json');
  body.idempotencyKey = 'key-1';
  const first = engine.run(body);
  const replay = engine.run(body);
  assert.equal(replay.runId, first.runId, 'identical replay must return the original run id');

  const changed = loadFixture('sbom-boundary-excluded.json');
  changed.idempotencyKey = 'key-1';
  changed.packages[1].version = '9.9.9';
  changed.packages[0].dependencies['lib-edge'] = '9.9.9';
  assert.throws(() => engine.run(changed),
    (e) => e instanceof ScanError && e.category === 'STATE_CONFLICT');
});

test('invalid input fails as INPUT_ERROR, never as success', () => {
  const { engine } = makeEngine();
  for (const bad of [
    null,
    {},
    { root: 'app@1.0.0', packages: [] },
    { root: 'app@1.0.0', packages: [{ name: 'app', version: '1.0' }] },
    { root: 'ghost@1.0.0', packages: [{ name: 'app', version: '1.0.0' }] },
  ]) {
    assert.throws(() => engine.run(bad),
      (e) => e instanceof ScanError && e.category === 'INPUT_ERROR',
      'expected INPUT_ERROR for ' + JSON.stringify(bad));
  }
});

test('failed runs persist a failed report and replayable logs (run id in error detail)', () => {
  const { engine, store } = makeEngine();
  let caught;
  try {
    engine.run({ root: 'app@1.0.0', packages: [] });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ScanError);
  assert.equal(caught.category, 'INPUT_ERROR');
  const runId = caught.detail.runId;
  assert.ok(runId, 'error detail must carry the run id');
  const row = store.getRun(runId);
  assert.equal(row.status, 'failed');
  const report = JSON.parse(row.report_json);
  assert.equal(report.error.category, 'INPUT_ERROR');
  const logs = store.getLogs(runId);
  assert.ok(logs.some((l) => l.step === 'error'), 'run log must record the error event');
});

test('resource exhaustion fails as RESOURCE_EXHAUSTED with run id', () => {
  const store = new Store(':memory:');
  store.loadVulnDb('fixtures/vuln-db.json');
  const engine = new ScanEngine(store, { maxPackages: 1000, maxDepth: 2 });
  const body = loadFixture('sbom-deep.json');
  delete body.idempotencyKey;
  assert.throws(() => engine.run(body),
    (e) => e instanceof ScanError && e.category === 'RESOURCE_EXHAUSTED' && typeof e.detail.runId === 'string');
});
