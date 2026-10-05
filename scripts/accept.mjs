// One-shot acceptance script: boots the service on an ephemeral port and
// walks every required scenario in a fixed order, printing request, response
// and the judgement for each step. Exit 0 iff all scenarios pass; on failure
// exits non-zero and names the failed scenario.
//
// Usage: npm run accept
// Env:   MTS_EXECUTOR=inprocess  (required where child processes are blocked)
import { MutationStore } from '../src/store/sqlite.ts';
import { MutationService } from '../src/service.ts';
import { createHttpServer } from '../src/server/http.ts';
import { loadConfig } from '../src/config.ts';

const executor = process.env.MTS_EXECUTOR ?? 'inprocess';
const config = loadConfig({ MTS_EXECUTOR: executor, MTS_DB: ':memory:' });
const service = new MutationService(new MutationStore(config.dbPath), config, () => {});
const server = createHttpServer(service, () => {});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

let failed = null;
let step = 0;

function show(title, data) {
  console.log('  ' + title + ': ' + (typeof data === 'string' ? data : JSON.stringify(data)));
}

async function scenario(name, fn) {
  step++;
  console.log('\n[' + step + '] ' + name);
  if (failed) {
    console.log('  SKIP (earlier failure: ' + failed + ')');
    return;
  }
  try {
    await fn();
    console.log('  => PASS');
  } catch (err) {
    failed = name;
    console.log('  => FAIL: ' + (err instanceof Error ? err.message : String(err)));
  }
}

function check(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(path) {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
}

let mixedRunId = null;

await scenario('health check', async () => {
  const r = await get('/health');
  show('response', r.body);
  check(r.status === 200 && r.body.status === 'ok', 'expected 200 {status:ok}');
});

await scenario('killed mutant: fixtures/killed scores 1.0', async () => {
  const req = { projectDir: 'fixtures/killed' };
  show('request', req);
  const r = await post('/runs', req);
  show('response', { status: r.status, total: r.body.total, killed: r.body.killed, score: r.body.score, mutantStatus: r.body.results?.[0]?.status });
  check(r.status === 201, 'expected 201, got ' + r.status);
  check(r.body.total === 1 && r.body.killed === 1 && r.body.score === 1, 'expected 1/1 killed, score 1');
  check(r.body.results[0].status === 'killed', 'mutant must be killed');
  check(r.body.results[0].testExitCode !== 0, 'killed mutant must have non-zero test exit code');
});

await scenario('survived mutant: fixtures/survived scores 0.0', async () => {
  const req = { projectDir: 'fixtures/survived' };
  show('request', req);
  const r = await post('/runs', req);
  show('response', { status: r.status, total: r.body.total, survived: r.body.survived, score: r.body.score, survivors: r.body.survivors });
  check(r.status === 201, 'expected 201, got ' + r.status);
  check(r.body.total === 1 && r.body.survived === 1 && r.body.score === 0, 'expected 0/1 killed, score 0');
  check(r.body.survivors.length === 1 && r.body.survivors[0].original === '*', 'survivor must be the * mutant');
});

await scenario('mixed fixture: fixtures/sample scores 0.8 with one survivor', async () => {
  const req = { projectDir: 'fixtures/sample' };
  show('request', req);
  const r = await post('/runs', req);
  mixedRunId = r.body.runId;
  show('response', { status: r.status, runId: r.body.runId, total: r.body.total, killed: r.body.killed, survived: r.body.survived, score: r.body.score });
  check(r.status === 201, 'expected 201, got ' + r.status);
  check(r.body.total === 5 && r.body.killed === 4 && r.body.survived === 1, 'expected 5 mutants, 4 killed, 1 survived');
  check(r.body.score === 0.8, 'expected score 0.8, got ' + r.body.score);
  const s = r.body.survivors[0];
  check(s && s.file === 'src/calc.js' && s.original === '*' && s.type === 'ArithmeticOperator',
    'survivor must be the * -> / mutant in src/calc.js');
  for (const res of r.body.results) {
    show('mutant', res.mutant.id + ' -> ' + res.status + ' (' + res.reason + ')');
  }
});

await scenario('replay: GET /runs/:id returns the persisted run', async () => {
  const r = await get('/runs/' + mixedRunId);
  show('response', { status: r.status, runId: r.body.runId, score: r.body.score, results: r.body.results?.length });
  check(r.status === 200, 'expected 200, got ' + r.status);
  check(r.body.runId === mixedRunId && r.body.results.length === 5 && r.body.score === 0.8,
    'replayed run must match the original');
});

await scenario('history query by file and by mutation type', async () => {
  const byFile = await get('/mutants?file=' + encodeURIComponent('src/notify.js'));
  show('by file src/notify.js', { count: byFile.body.count });
  check(byFile.status === 200 && byFile.body.count === 2, 'expected 2 mutants in src/notify.js');
  const byType = await get('/mutants?type=ArithmeticOperator&status=survived');
  show('by type ArithmeticOperator+survived', { count: byType.body.count, ids: byType.body.results?.map((r) => r.mutant.id) });
  check(byType.status === 200 && byType.body.count === 2, 'expected 2 survived arithmetic mutants across runs (survived fixture + sample)');
  check(byType.body.results.every((r) => r.mutant.original === '*'), 'all survived arithmetic mutants must be *');
  check(byType.body.results.some((r) => r.mutant.id === 'src/calc.js:92:ArithmeticOperator:0'), 'sample survivor must be present');
  const combined = await get('/mutants?file=' + encodeURIComponent('src/notify.js') + '&type=RemoveCall&status=killed');
  show('by file+type+status', { count: combined.body.count });
  check(combined.status === 200 && combined.body.count === 1, 'expected exactly 1 killed RemoveCall mutant in src/notify.js');
});

await scenario('error semantics: INPUT_INVALID (400)', async () => {
  const bad1 = await post('/runs', '{not json');
  show('invalid JSON', { status: bad1.status, code: bad1.body.error?.code });
  check(bad1.status === 400 && bad1.body.error.code === 'INPUT_INVALID', 'invalid JSON must be 400 INPUT_INVALID');
  const bad2 = await post('/runs', {});
  show('missing projectDir', { status: bad2.status, code: bad2.body.error?.code });
  check(bad2.status === 400 && bad2.body.error.code === 'INPUT_INVALID', 'missing projectDir must be 400 INPUT_INVALID');
  const bad3 = await post('/runs', { projectDir: 'no/such/dir' });
  show('nonexistent projectDir', { status: bad3.status, code: bad3.body.error?.code });
  check(bad3.status === 400 && bad3.body.error.code === 'INPUT_INVALID', 'nonexistent dir must be 400 INPUT_INVALID');
});

await scenario('error semantics: NOT_FOUND (404)', async () => {
  const r = await get('/runs/00000000-0000-0000-0000-000000000000');
  show('response', { status: r.status, code: r.body.error?.code });
  check(r.status === 404 && r.body.error.code === 'NOT_FOUND', 'unknown run id must be 404 NOT_FOUND');
});

await scenario('error semantics: STATE_CONFLICT (409) on concurrent runs', async () => {
  // Build a temp project with many mutants so the first run is still in
  // flight when the second request arrives.
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mts-accept-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  const lines = ['export function f(x) {', '  let acc = x;'];
  for (let i = 0; i < 120; i++) lines.push('  acc = acc + ' + i + ';');
  lines.push('  return acc;', '}');
  writeFileSync(join(dir, 'src', 'big.js'), lines.join('\n'));
  writeFileSync(join(dir, 'test', 'big.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n" +
    "import { f } from '../src/big.js';\n" +
    "test('f accumulates', () => { assert.equal(f(0), " + (120 * 119 / 2) + "); });\n");
  try {
    const req = { projectDir: dir };
    const [a, b] = await Promise.all([post('/runs', req), post('/runs', req)]);
    show('responses', [{ status: a.status, code: a.body.error?.code }, { status: b.status, code: b.body.error?.code }]);
    const conflicts = [a, b].filter((r) => r.status === 409 && r.body.error?.code === 'STATE_CONFLICT');
    const successes = [a, b].filter((r) => r.status === 201);
    check(conflicts.length === 1 && successes.length === 1,
      'exactly one concurrent run must win, the other must be 409 STATE_CONFLICT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await scenario('error semantics: RESOURCE_EXHAUSTED (429)', async () => {
  const r = await post('/runs', { projectDir: 'fixtures/sample', maxMutants: 2 });
  show('response', { status: r.status, code: r.body.error?.code, details: r.body.error?.details });
  check(r.status === 429 && r.body.error.code === 'RESOURCE_EXHAUSTED', 'budget overflow must be 429 RESOURCE_EXHAUSTED');
});

await scenario('error semantics: EXECUTION_FAILED (502) on broken test command', async () => {
  // Separate service with the spawn executor: a nonexistent test binary must
  // surface EXECUTION_FAILED regardless of whether spawning is permitted.
  const spawnSvc = new MutationService(new MutationStore(':memory:'),
    loadConfig({ MTS_EXECUTOR: 'spawn', MTS_DB: ':memory:' }), () => {});
  const spawnServer = createHttpServer(spawnSvc, () => {});
  await new Promise((resolve) => spawnServer.listen(0, '127.0.0.1', resolve));
  const spawnBase = 'http://127.0.0.1:' + spawnServer.address().port;
  try {
    const res = await fetch(spawnBase + '/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectDir: 'fixtures/killed', testCommand: 'definitely-not-a-real-binary-xyz' }),
    });
    const body = await res.json();
    show('response', { status: res.status, code: body.error?.code });
    check(res.status === 502 && body.error.code === 'EXECUTION_FAILED',
      'broken test command must be 502 EXECUTION_FAILED');
  } finally {
    spawnServer.close();
  }
});

server.close();

console.log('\n========================================');
if (failed) {
  console.log('ACCEPTANCE FAILED at scenario: ' + failed);
  process.exit(1);
}
console.log('ACCEPTANCE PASSED: all ' + step + ' scenarios green (executor=' + executor + ')');
process.exit(0);

