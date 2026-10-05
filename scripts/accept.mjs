// One-shot acceptance script: boots the service on a scratch port and DB,
// then walks every scenario in a fixed order, printing request, response
// summary, and the PASS/FAIL judgement for each. Exit 0 only if all pass.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4391;
const BASE = 'http://127.0.0.1:' + PORT;
const DB = path.join(root, 'data', 'accept.db');

fs.mkdirSync(path.dirname(DB), { recursive: true });
fs.rmSync(DB, { force: true });

const serviceLog = fs.openSync(path.join(root, 'data', 'accept-service.log'), 'w');
const service = spawn(process.execPath, [path.join(root, 'src', 'index.ts')], {
  env: { ...process.env, MUTATION_PORT: String(PORT), MUTATION_DB: DB, MUTATION_WORKSPACE_ROOT: path.join(root, '.accept-workspaces') },
  stdio: ['ignore', serviceLog, serviceLog],
});

let failures = 0;
const step = (name, ok, detail) => {
  console.log('  judgement: ' + (ok ? 'PASS' : 'FAIL') + (detail ? ' — ' + detail : ''));
  if (!ok) {
    failures += 1;
    console.log('  !! scenario failed: ' + name);
  }
  console.log('');
};

const post = async (body) => {
  const res = await fetch(BASE + '/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const waitHealthy = async () => {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(BASE + '/health');
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

const fixture = (name) => path.join(root, 'fixtures', name);

const main = async () => {
  console.log('== booting service on ' + BASE + ' (db: ' + DB + ')');
  if (!(await waitHealthy())) {
    console.log('service did not become healthy');
    process.exitCode = 1;
    return;
  }
  console.log('service healthy\n');

  console.log('--- scenario 1: killed mutant (killed-project) ---');
  let req = { projectDir: fixture('killed-project'), sourceFile: 'src/calc.js' };
  console.log('  request: POST /runs ' + JSON.stringify(req));
  let r = await post(req);
  console.log('  response: HTTP ' + r.status + ' runId=' + r.body.runId + ' score=' + r.body.score + ' killed=' + r.body.killed + '/' + r.body.total);
  step('killed', r.status === 201 && r.body.score === 1 && r.body.killed === 1 && r.body.total === 1,
    'expected score 1 with 1/1 killed');

  console.log('--- scenario 2: surviving mutant (survived-project) ---');
  req = { projectDir: fixture('survived-project'), sourceFile: 'src/calc.js' };
  console.log('  request: POST /runs ' + JSON.stringify(req));
  r = await post(req);
  console.log('  response: HTTP ' + r.status + ' score=' + r.body.score + ' survived=' + r.body.survived + ' survivors=' + JSON.stringify((r.body.survivors ?? []).map((m) => m.id)));
  step('survived', r.body.score === 0 && r.body.survived === 1 && r.body.survivors.length === 1,
    'expected score 0 with exactly 1 survivor');

  console.log('--- scenario 3: mixed outcome (mixed-project) ---');
  req = { projectDir: fixture('mixed-project'), sourceFile: 'src/calc.js' };
  console.log('  request: POST /runs ' + JSON.stringify(req));
  r = await post(req);
  const survivorTypes = (r.body.survivors ?? []).map((m) => m.mutator);
  console.log('  response: HTTP ' + r.status + ' score=' + r.body.score + ' killed=' + r.body.killed + ' survived=' + r.body.survived + ' survivorTypes=' + JSON.stringify(survivorTypes));
  step('mixed', r.body.total === 3 && r.body.killed === 2 && Math.abs(r.body.score - 2 / 3) < 1e-9 && survivorTypes.join() === 'CallRemoval',
    'expected 2/3 killed, CallRemoval survives');
  const mixedRunId = r.body.runId;

  console.log('--- scenario 4: failing baseline (broken-project) ---');
  req = { projectDir: fixture('broken-project'), sourceFile: 'src/calc.js' };
  console.log('  request: POST /runs ' + JSON.stringify(req));
  r = await post(req);
  console.log('  response: HTTP ' + r.status + ' status=' + r.body.status);
  step('baseline_failed', r.body.status === 'baseline_failed' && r.body.total === 0,
    'unmutated suite fails, run must abort with baseline_failed');

  console.log('--- scenario 5: infinite-loop mutant (timeout-project) ---');
  req = { projectDir: fixture('timeout-project'), sourceFile: 'src/counter.js', timeoutMs: 8000 };
  console.log('  request: POST /runs ' + JSON.stringify(req));
  r = await post(req);
  console.log('  response: HTTP ' + r.status + ' timeout=' + r.body.timeout + ' mutantStatus=' + (r.body.mutants?.[0]?.status));
  step('timeout', r.body.timeout === 1 && r.body.mutants?.[0]?.status === 'timeout',
    'i+1 -> i-1 loops forever, must be classified as timeout');

  console.log('--- scenario 6: input error (missing projectDir) ---');
  req = { projectDir: path.join(root, 'fixtures', 'no-such-dir'), sourceFile: 'x.js' };
  console.log('  request: POST /runs ' + JSON.stringify(req));
  r = await post(req);
  console.log('  response: HTTP ' + r.status + ' ' + JSON.stringify(r.body));
  step('input_error', r.status === 400 && r.body.error?.category === 'INPUT_ERROR',
    'expected 400 INPUT_ERROR');

  console.log('--- scenario 7: resource exhausted (timeoutMs above max) ---');
  req = { projectDir: fixture('killed-project'), sourceFile: 'src/calc.js', timeoutMs: 999999 };
  console.log('  request: POST /runs ' + JSON.stringify(req));
  r = await post(req);
  console.log('  response: HTTP ' + r.status + ' ' + JSON.stringify(r.body));
  step('resource_exhausted', r.status === 503 && r.body.error?.category === 'RESOURCE_EXHAUSTED',
    'expected 503 RESOURCE_EXHAUSTED');

  console.log('--- scenario 8: history query by file and mutator ---');
  let res = await fetch(BASE + '/mutants?file=' + encodeURIComponent('src/calc.js') + '&mutator=CallRemoval');
  let rows = (await res.json()).mutants;
  console.log('  request: GET /mutants?file=src/calc.js&mutator=CallRemoval');
  console.log('  response: HTTP ' + res.status + ' rows=' + rows.length + ' statuses=' + JSON.stringify(rows.map((x) => x.status)));
  step('query', res.status === 200 && rows.length >= 1 && rows.every((x) => x.mutator === 'CallRemoval'),
    'expected stored CallRemoval mutants from earlier runs');

  console.log('--- scenario 9: replay a stored run by id ---');
  res = await fetch(BASE + '/runs/' + mixedRunId);
  const replay = await res.json();
  console.log('  request: GET /runs/' + mixedRunId);
  console.log('  response: HTTP ' + res.status + ' score=' + replay.score + ' logLines=' + (replay.log?.length ?? 0));
  step('replay', res.status === 200 && replay.runId === mixedRunId && Math.abs(replay.score - 2 / 3) < 1e-9 && replay.log.length > 0,
    'stored report must replay identical score and logs');

  console.log('--- scenario 10: unknown run id ---');
  res = await fetch(BASE + '/runs/R-does-not-exist');
  const notFound = await res.json();
  console.log('  request: GET /runs/R-does-not-exist');
  console.log('  response: HTTP ' + res.status + ' ' + JSON.stringify(notFound));
  step('not_found', res.status === 404 && notFound.error?.category === 'INPUT_ERROR',
    'expected 404 INPUT_ERROR, not a success envelope');

  console.log(failures === 0 ? 'ALL SCENARIOS PASSED' : failures + ' SCENARIO(S) FAILED');
  process.exitCode = failures === 0 ? 0 : 1;
};

main().finally(() => {
  service.kill();
  fs.closeSync(serviceLog);
});
