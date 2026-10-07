// One-shot acceptance drill: runs unit tests, boots the service on a temp DB,
// then walks every required scenario in a fixed order, printing request,
// response and verdict per step. Exit 0 iff every step passes.
import { run as runTests } from 'node:test';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/diag/server.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL('../fixtures/' + name, import.meta.url), 'utf8'));

let failures = 0;
let stepNo = 0;

function step(title: string): void {
  stepNo += 1;
  console.log('\n=== Step ' + stepNo + ': ' + title + ' ===');
}

function verdict(ok: boolean, reason: string): void {
  console.log((ok ? 'VERDICT: PASS' : 'VERDICT: FAIL') + ' - ' + reason);
  if (!ok) failures += 1;
}

function show(label: string, value: unknown): void {
  console.log(label + ': ' + JSON.stringify(value));
}

async function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
  show('REQUEST  POST ' + url, body);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  show('RESPONSE ' + res.status, json);
  return { status: res.status, json };
}

async function get(url: string): Promise<{ status: number; json: any }> {
  console.log('REQUEST  GET ' + url);
  const res = await fetch(url);
  const json = await res.json();
  show('RESPONSE ' + res.status, json);
  return { status: res.status, json };
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Step 0: unit tests must actually run and pass.
step('unit tests (node --test test/)');
let unitPass = 0;
let unitFail = 0;
const stream = runTests({ files: ['test/merge.test.ts', 'test/drift.test.ts', 'test/api.test.ts'], isolation: 'none' });
stream.on('test:pass', (t) => { unitPass += 1; console.log('ok - ' + t.name); });
stream.on('test:fail', (t) => { unitFail += 1; console.log('not ok - ' + t.name); });
await new Promise<void>((resolve) => stream.on('test:summary', () => resolve()));
console.log('unit tests: ' + unitPass + ' passed, ' + unitFail + ' failed');
verdict(unitFail === 0 && unitPass > 0, 'unit tests ' + unitPass + ' passed / ' + unitFail + ' failed');
const dbPath = join(tmpdir(), 'env-drift-accept-' + process.pid + '.db');
const app = buildServer({ dbPath });
await app.listen({ port: 0, host: '127.0.0.1' });
const address = app.server.address();
const base = 'http://127.0.0.1:' + (typeof address === 'object' && address ? address.port : 0);
console.log('\nservice up at ' + base + ' (db: ' + dbPath + ')');

const layers = {
  base: fixture('base.json'),
  env: fixture('env.dev.json'),
  instance: fixture('instance.patch.json'),
};

try {
  step('health check');
  {
    const r = await get(base + '/health');
    verdict(r.status === 200 && r.json.status === 'ok', 'service healthy');
  }

  step('layered merge semantics: deep merge + array replace + null delete');
  let runId = '';
  {
    const r = await post(base + '/api/evaluations', { env: 'dev', layers, snapshot: fixture('snapshot.drifting.json') });
    const expectedEffective = {
      service: { name: 'checkout', port: 9090, replicas: 3 },
      features: { search: true },
      limits: { cpu: '1000m', memory: '256Mi' },
      tags: ['dev', 'canary'],
      logging: { level: 'debug', format: 'json' },
      instanceId: 'i-local-01',
    };
    const ok =
      r.status === 201 &&
      eq(r.json.effective, expectedEffective) &&
      r.json.effective.tags.length === 2 && // array replaced, not merged
      !('deprecated' in r.json.effective) && // null deleted whole subtree
      !('legacyCheckout' in r.json.effective.features); // null deleted nested key
    runId = r.json.runId ?? '';
    verdict(ok, 'effective config matches hand-written reference (deep merge, array replace, null delete)');
  }

  step('drift classification: missing > mismatch > extra with dot paths');
  {
    const r = await get(base + '/api/runs/' + runId);
    const items = r.json.output?.drift?.items ?? [];
    const got = items.map((i: any) => [i.category, i.path]);
    const want = [
      ['missing', 'limits.memory'],
      ['mismatch', 'service.port'],
      ['extra', 'runtime.node'],
    ];
    verdict(r.status === 200 && eq(got, want), 'drift items ' + JSON.stringify(got));
  }

  step('no drift yields explicit pass marker');
  {
    const r = await post(base + '/api/evaluations', { env: 'dev', layers, snapshot: fixture('snapshot.clean.json') });
    verdict(r.status === 201 && r.json.drift.status === 'pass' && r.json.drift.items.length === 0, 'status=pass, 0 items');
  }

  step('invalid layer rejected: empty key names layer and path');
  {
    const r = await post(base + '/api/evaluations', {
      env: 'dev',
      layers: { base: { a: 1 }, env: { bad: { '': 1 } }, instance: {} },
      snapshot: {},
    });
    verdict(
      r.status === 422 && r.json.error?.code === 'INVALID_LAYER' && r.json.error?.details?.layer === 'env' && r.json.error?.details?.path === 'bad',
      'error code INVALID_LAYER, layer=env, path=bad',
    );
  }

  step('invalid layer rejected: non-object layer');
  {
    const r = await post(base + '/api/evaluations', {
      env: 'dev',
      layers: { base: [1, 2], env: {}, instance: {} },
      snapshot: {},
    });
    verdict(r.status === 422 && r.json.error?.code === 'INVALID_LAYER' && r.json.error?.details?.layer === 'base', 'base layer rejected');
  }

  step('replay by env: stored layered sources and drift result retrievable');
  {
    const list = await get(base + '/api/runs?env=dev');
    const found = (list.json.runs ?? []).find((r: any) => r.runId === runId);
    const replay = await get(base + '/api/runs/' + runId);
    verdict(
      Boolean(found) && eq(replay.json.input?.layers, layers) && replay.json.output?.drift?.status === 'drifted',
      'run ' + runId + ' replays with original layers and drift result',
    );
  }

  step('unknown run id is NOT_FOUND, never a silent success');
  {
    const r = await get(base + '/api/runs/nope');
    verdict(r.status === 404 && r.json.error?.code === 'NOT_FOUND', '404 NOT_FOUND returned');
  }
} finally {
  await app.close();
  rmSync(dbPath, { force: true });
}

console.log('\n========================================');
if (failures > 0) {
  console.log('ACCEPTANCE FAILED: ' + failures + ' scenario(s) failed');
  process.exit(1);
}
console.log('ACCEPTANCE PASSED: all ' + stepNo + ' scenarios green');
process.exit(0);
