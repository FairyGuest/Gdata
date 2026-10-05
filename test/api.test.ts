import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server.ts';
import { Store } from '../src/store.ts';

let server: Server;
let store: Store;
let base: string;
let canSpawn = false;

function probeSpawn(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
      const args = process.platform === 'win32' ? ['/c', 'echo', 'ok'] : ['-c', 'echo ok'];
      execFile(shell, args, (err) => resolve(err === null));
    } catch {
      resolve(false);
    }
  });
}

before(async () => {
  canSpawn = await probeSpawn();
  store = new Store(':memory:');
  server = createApp({
    store,
    limits: { maxRuns: 10, maxTestsPerSuite: 20 },
    classifyOptions: { passTarget: 0.99, maxSuggestedRetries: 10 },
    executorOptions: { cmdTimeoutMs: 500 },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});

after(() => {
  server.close();
  store.close();
});

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function get(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path);
  return { status: res.status, json: await res.json() };
}

const mixedSuite = {
  suiteId: 'demo',
  runs: 4,
  tests: [
    { kind: 'scripted', name: 'always-pass', outcomes: ['pass'] },
    { kind: 'scripted', name: 'always-fail', outcomes: ['fail'] },
    { kind: 'scripted', name: 'alternating', outcomes: ['pass', 'fail'] },
  ],
};

test('health endpoint', async () => {
  const { status, json } = await get('/health');
  assert.equal(status, 200);
  assert.equal(json.status, 'ok');
});

test('mixed suite classifies each test with expected category, distribution and first failure', async () => {
  const { status, json } = await post('/v1/runs', mixedSuite);
  assert.equal(status, 200);
  assert.equal(json.runs, 4);
  const byName = Object.fromEntries(json.classifications.map((c: any) => [c.name, c]));

  assert.equal(byName['always-pass'].category, 'stable-pass');
  assert.equal(byName['always-pass'].confidence, 0.9375); // 1 - 2^-4
  assert.equal(byName['always-pass'].firstFailureRun, null);

  assert.equal(byName['always-fail'].category, 'stable-fail');
  assert.equal(byName['always-fail'].firstFailureRun, 1);

  assert.equal(byName['alternating'].category, 'flaky');
  assert.equal(byName['alternating'].passCount, 2);
  assert.equal(byName['alternating'].failCount, 2);
  assert.equal(byName['alternating'].firstFailureRun, 2);
  assert.equal(byName['alternating'].confidence, 1);
  assert.equal(byName['alternating'].suggestedRetries, 6);

  // run log must allow replay: 4 runs x 3 tests, 1-based run indices
  assert.equal(json.log.length, 12);
  assert.deepEqual(
    json.log.filter((e: any) => e.testName === 'alternating').map((e: any) => [e.runIndex, e.outcome]),
    [[1, 'pass'], [2, 'fail'], [3, 'pass'], [4, 'fail']],
  );
  assert.ok(json.log.every((e: any) => typeof e.reason === 'string' && e.reason.length > 0));
});

test('history endpoint aggregates classification trend across rounds', async () => {
  await post('/v1/runs', { suiteId: 'hist-a', runs: 3, tests: [{ kind: 'scripted', name: 'trendy', outcomes: ['pass', 'fail'] }] });
  await post('/v1/runs', { suiteId: 'hist-b', runs: 5, tests: [{ kind: 'scripted', name: 'trendy', outcomes: ['pass'] }] });
  const { status, json } = await get('/v1/tests/trendy/history');
  assert.equal(status, 200);
  assert.equal(json.rounds.length, 2);
  assert.equal(json.rounds[0].category, 'flaky');
  assert.equal(json.rounds[0].runs, 3);
  assert.equal(json.rounds[1].category, 'stable-pass');
  assert.equal(json.rounds[1].runs, 5);
  assert.ok(json.rounds[1].confidence > json.rounds[0].confidence);
});

test('report endpoint replays a stored round', async () => {
  const { json: run } = await post('/v1/runs', { suiteId: 'rep', runs: 2, tests: [{ kind: 'scripted', name: 'x', outcomes: ['fail'] }] });
  const { status, json } = await get('/v1/reports/' + run.roundId);
  assert.equal(status, 200);
  assert.equal(json.round.status, 'completed');
  assert.equal(json.classifications[0].category, 'stable-fail');
  assert.equal(json.log.length, 2);
});

test('unknown report id is NOT_FOUND', async () => {
  const { status, json } = await get('/v1/reports/9999');
  assert.equal(status, 404);
  assert.equal(json.error.code, 'NOT_FOUND');
});

test('unknown test history is NOT_FOUND', async () => {
  const { status, json } = await get('/v1/tests/ghost/history');
  assert.equal(status, 404);
  assert.equal(json.error.code, 'NOT_FOUND');
});

test('malformed JSON body is INPUT_ERROR 400', async () => {
  const { status, json } = await post('/v1/runs', '{not json');
  assert.equal(status, 400);
  assert.equal(json.error.code, 'INPUT_ERROR');
});

test('invalid runs value is INPUT_ERROR 400', async () => {
  const { status, json } = await post('/v1/runs', { suiteId: 's', runs: 0, tests: [{ kind: 'scripted', name: 't', outcomes: ['pass'] }] });
  assert.equal(status, 400);
  assert.equal(json.error.code, 'INPUT_ERROR');
});

test('runs above limit is RESOURCE_EXHAUSTED 429', async () => {
  const { status, json } = await post('/v1/runs', { suiteId: 's', runs: 11, tests: [{ kind: 'scripted', name: 't', outcomes: ['pass'] }] });
  assert.equal(status, 429);
  assert.equal(json.error.code, 'RESOURCE_EXHAUSTED');
});

test('concurrent rounds of the same suite are rejected as STATE_CONFLICT 409', async () => {
  const suite = { suiteId: 'race', runs: 10, tests: [{ kind: 'scripted', name: 't', outcomes: ['pass'] }] };
  const [first, second] = await Promise.all([post('/v1/runs', suite), post('/v1/runs', suite)]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const conflict = first.status === 409 ? first : second;
  assert.equal(conflict.json.error.code, 'STATE_CONFLICT');
});

test('command execution failure surfaces as COMPUTATION_FAILED 502 and the round is marked failed', async () => {
  const sleepCmd = process.platform === 'win32' ? 'ping -n 5 127.0.0.1 >nul' : 'sleep 4';
  const { status, json } = await post('/v1/runs', {
    suiteId: 'slow',
    runs: 1,
    tests: [{ kind: 'command', name: 'slow-cmd', command: sleepCmd }],
  });
  // On hosts where child processes can spawn, the 500ms timeout kills the 4s
  // command; where spawning is denied, the spawn error itself is the failure.
  // Both must surface as COMPUTATION_FAILED, never as a passed run.
  assert.equal(status, 502);
  assert.equal(json.error.code, 'COMPUTATION_FAILED');
  const rounds = store.getTestHistory('slow-cmd');
  assert.equal(rounds.length, 0, 'failed rounds must not appear in history');
});

test('failing command exit code is a test failure, not a computation failure', async (t) => {
  if (!canSpawn) {
    t.skip('child process spawn is not permitted in this environment');
    return;
  }
  const failCmd = process.platform === 'win32' ? 'exit 1' : 'false';
  const { status, json } = await post('/v1/runs', {
    suiteId: 'cmdfail',
    runs: 2,
    tests: [{ kind: 'command', name: 'cmd-fails', command: failCmd }],
  });
  assert.equal(status, 200);
  assert.equal(json.classifications[0].category, 'stable-fail');
});
