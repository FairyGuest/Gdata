import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Store } from '../src/store.ts';
import { createApp } from '../src/server.ts';

const MAX_RUNS = 10;
const tmp = mkdtempSync(join(tmpdir(), 'flaky-accept-'));
const store = new Store(join(tmp, 'accept.db'));
const server: Server = createApp({
  store,
  limits: { maxRuns: MAX_RUNS, maxTestsPerSuite: 20 },
  classifyOptions: { passTarget: 0.99, maxSuggestedRetries: 10 },
  executorOptions: { cmdTimeoutMs: 500 },
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;

let failures = 0;

function show(label: string, value: unknown): void {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  console.log('  ' + label + ': ' + (s.length > 300 ? s.slice(0, 300) + '...' : s));
}

function check(scenario: string, ok: boolean, detail: string): void {
  console.log('  verdict: ' + (ok ? 'PASS' : 'FAIL') + ' - ' + detail);
  if (!ok) {
    failures++;
    console.log('  *** scenario FAILED: ' + scenario);
  }
}

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  console.log('\n[' + name + ']');
  try {
    await fn();
  } catch (err) {
    failures++;
    console.log('  verdict: FAIL - unexpected error: ' + (err instanceof Error ? err.message : String(err)));
  }
}

console.log('flaky-detector acceptance run');
console.log('server: ' + base + '  db: ' + join(tmp, 'accept.db') + '  maxRuns: ' + MAX_RUNS);

await scenario('S1 health', async () => {
  const r = await req('GET', '/health');
  show('response', r.json);
  check('S1', r.status === 200 && r.json.status === 'ok', 'service is healthy');
});

await scenario('S2 all-pass suite -> stable-pass', async () => {
  const body = { suiteId: 's2', runs: 5, tests: [{ kind: 'scripted', name: 'ok', outcomes: ['pass'] }] };
  show('request', body);
  const r = await req('POST', '/v1/runs', body);
  const c = r.json.classifications?.[0];
  show('classification', c);
  check('S2', r.status === 200 && c.category === 'stable-pass' && c.confidence === 0.9688 && c.suggestedRetries === 0,
    'category=stable-pass, confidence=1-2^-5=0.9688, retries=0');
});

await scenario('S3 all-fail suite -> stable-fail', async () => {
  const body = { suiteId: 's3', runs: 4, tests: [{ kind: 'scripted', name: 'bad', outcomes: ['fail'] }] };
  show('request', body);
  const r = await req('POST', '/v1/runs', body);
  const c = r.json.classifications?.[0];
  show('classification', c);
  check('S3', r.status === 200 && c.category === 'stable-fail' && c.confidence === 0.9375 && c.firstFailureRun === 1,
    'category=stable-fail, confidence=1-2^-4=0.9375, firstFailureRun=1');
});

await scenario('S4 alternating suite -> flaky with distribution and first failure run', async () => {
  const body = { suiteId: 's4', runs: 4, tests: [{ kind: 'scripted', name: 'alt', outcomes: ['pass', 'fail'] }] };
  show('request', body);
  const r = await req('POST', '/v1/runs', body);
  const c = r.json.classifications?.[0];
  show('classification', c);
  const logOk = JSON.stringify(r.json.log?.map((e: any) => e.outcome)) === '["pass","fail","pass","fail"]';
  check('S4', r.status === 200 && c.category === 'flaky' && c.passCount === 2 && c.failCount === 2 &&
    c.firstFailureRun === 2 && c.confidence === 1 && c.suggestedRetries === 6 && logOk,
    'flaky, 2/2 distribution, firstFailureRun=2, confidence=1, retries=6, replayable log');
});

await scenario('S5 flaky confidence: 1 fail in 3 runs > 1 fail in 10 runs', async () => {
  const r3 = await req('POST', '/v1/runs', { suiteId: 's5a', runs: 3, tests: [{ kind: 'scripted', name: 'f3', outcomes: ['fail', 'pass', 'pass'] }] });
  const r10 = await req('POST', '/v1/runs', { suiteId: 's5b', runs: 10, tests: [{ kind: 'scripted', name: 'f10', outcomes: ['fail','pass','pass','pass','pass','pass','pass','pass','pass','pass'] }] });
  const c3 = r3.json.classifications?.[0];
  const c10 = r10.json.classifications?.[0];
  show('3-run confidence', c3?.confidence);
  show('10-run confidence', c10?.confidence);
  check('S5', c3?.confidence === 0.6667 && c10?.confidence === 0.2 && c3.confidence > c10.confidence,
    '2*1/3=0.6667 > 2*1/10=0.2');
});

await scenario('S6 cross-round history trend for one test', async () => {
  await req('POST', '/v1/runs', { suiteId: 's6a', runs: 4, tests: [{ kind: 'scripted', name: 'trend', outcomes: ['pass', 'fail'] }] });
  await req('POST', '/v1/runs', { suiteId: 's6b', runs: 6, tests: [{ kind: 'scripted', name: 'trend', outcomes: ['pass'] }] });
  const r = await req('GET', '/v1/tests/trend/history');
  show('history', r.json.rounds?.map((x: any) => [x.roundId, x.category, x.confidence]));
  check('S6', r.status === 200 && r.json.rounds?.length === 2 &&
    r.json.rounds[0].category === 'flaky' && r.json.rounds[1].category === 'stable-pass',
    'round1 flaky -> round2 stable-pass, trend queryable by test name');
});

await scenario('S7 report replay by round id', async () => {
  const run = await req('POST', '/v1/runs', { suiteId: 's7', runs: 2, tests: [{ kind: 'scripted', name: 'x', outcomes: ['fail'] }] });
  const r = await req('GET', '/v1/reports/' + run.json.roundId);
  show('round', r.json.round);
  check('S7', r.status === 200 && r.json.round?.status === 'completed' && r.json.log?.length === 2 &&
    r.json.log.every((e: any) => e.runIndex >= 1 && e.reason),
    'stored round replays with run indices and reasons');
});

await scenario('S8 input error -> 400 INPUT_ERROR', async () => {
  const bad1 = await req('POST', '/v1/runs', '{broken');
  const bad2 = await req('POST', '/v1/runs', { suiteId: 's8', runs: 0, tests: [{ kind: 'scripted', name: 't', outcomes: ['pass'] }] });
  show('bad json', bad1.json);
  show('runs=0', bad2.json);
  check('S8', bad1.status === 400 && bad1.json.error?.code === 'INPUT_ERROR' &&
    bad2.status === 400 && bad2.json.error?.code === 'INPUT_ERROR',
    'malformed JSON and invalid runs both map to 400 INPUT_ERROR');
});

await scenario('S9 state conflict -> 409 STATE_CONFLICT', async () => {
  const suite = { suiteId: 's9', runs: 10, tests: [{ kind: 'scripted', name: 't', outcomes: ['pass'] }] };
  const [a, b] = await Promise.all([req('POST', '/v1/runs', suite), req('POST', '/v1/runs', suite)]);
  const statuses = [a.status, b.status].sort().join(',');
  const conflict = a.status === 409 ? a : b;
  show('statuses', statuses);
  show('conflict body', conflict.json);
  check('S9', statuses === '200,409' && conflict.json.error?.code === 'STATE_CONFLICT',
    'one round completes, the overlapping one is rejected with 409 STATE_CONFLICT');
});

await scenario('S10 resource exhausted -> 429 RESOURCE_EXHAUSTED', async () => {
  const r = await req('POST', '/v1/runs', { suiteId: 's10', runs: MAX_RUNS + 1, tests: [{ kind: 'scripted', name: 't', outcomes: ['pass'] }] });
  show('response', r.json);
  check('S10', r.status === 429 && r.json.error?.code === 'RESOURCE_EXHAUSTED',
    'runs=' + (MAX_RUNS + 1) + ' exceeds maxRuns=' + MAX_RUNS);
});

await scenario('S11 computation failure -> 502 COMPUTATION_FAILED, round marked failed', async () => {
  const sleepCmd = process.platform === 'win32' ? 'ping -n 5 127.0.0.1 >nul' : 'sleep 4';
  const body = { suiteId: 's11', runs: 1, tests: [{ kind: 'command', name: 'slow', command: sleepCmd }] };
  show('request', body);
  const r = await req('POST', '/v1/runs', body);
  show('response', r.json);
  const hist = await req('GET', '/v1/tests/slow/history');
  check('S11', r.status === 502 && r.json.error?.code === 'COMPUTATION_FAILED' && hist.status === 404,
    'timed-out command is COMPUTATION_FAILED and does not pollute history');
});

await scenario('S12 not found -> 404 NOT_FOUND', async () => {
  const r = await req('GET', '/v1/reports/424242');
  show('response', r.json);
  check('S12', r.status === 404 && r.json.error?.code === 'NOT_FOUND', 'unknown round id is 404 NOT_FOUND');
});

console.log('\n========================================');
if (failures === 0) {
  console.log('ACCEPTANCE: all 12 scenarios passed');
} else {
  console.log('ACCEPTANCE: ' + failures + ' scenario(s) FAILED');
}
server.close();
store.close();
rmSync(tmp, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
