import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RunningServer } from '../src/api/server.ts';
import type { ServiceConfig } from '../src/config.ts';

let server: RunningServer;
let base: string;
const config: ServiceConfig = {
  port: 0, dbPath: ':memory:', defaultRuns: 5, maxRuns: 100,
  targetReliability: 0.99, maxRetries: 5,
};

before(async () => {
  server = await createServer(config, () => {});
  base = `http://127.0.0.1:${server.port}`;
});
after(async () => { await server.close(); });

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('POST /detections always-pass => stable_pass with confidence 0.9688', async () => {
  const { status, json } = await post('/detections', { testName: 'api-pass', pattern: 'always-pass', runs: 5 });
  assert.equal(status, 200);
  assert.equal(json.report.classification, 'stable_pass');
  assert.equal(json.report.confidence, 0.9688);
  assert.equal(json.runs.length, 5);
});

test('POST /detections alternate => flaky report with distribution and firstFailureRun', async () => {
  const { status, json } = await post('/detections', { testName: 'api-alt', pattern: 'alternate', runs: 6 });
  assert.equal(status, 200);
  assert.equal(json.report.classification, 'flaky');
  assert.deepEqual(json.report.distribution, { passes: 3, failures: 3 });
  assert.equal(json.report.firstFailureRun, 2);
  assert.equal(json.report.confidence, 0.9844);
});

test('GET /reports/:testName and /trend reflect stored history', async () => {
  await post('/detections', { testName: 'api-alt2', pattern: 'alternate', runs: 4 });
  await post('/detections', { testName: 'api-alt2', pattern: 'alternate', runs: 4 });
  const trend = await (await fetch(base + '/reports/api-alt2/trend')).json();
  assert.equal(trend.rounds, 2);
  assert.equal(trend.flakyRounds, 2);
  const latest = await (await fetch(base + '/reports/api-alt2')).json();
  assert.equal(latest.report.classification, 'flaky');
  assert.equal(latest.runs.length, 4);
});

test('invalid inputs => 400 INPUT_ERROR', async () => {
  for (const body of [
    { testName: '', pattern: 'always-pass' },
    { testName: 'x', pattern: 'always-pass', runs: 0 },
    { testName: 'x', pattern: 'does-not-exist' },
    { pattern: 'always-pass' },
  ]) {
    const { status, json } = await post('/detections', body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(json.error.code, 'INPUT_ERROR');
  }
});

test('runs above budget => 503 RESOURCE_EXHAUSTED', async () => {
  const { status, json } = await post('/detections', { testName: 'x', pattern: 'always-pass', runs: 100000 });
  assert.equal(status, 503);
  assert.equal(json.error.code, 'RESOURCE_EXHAUSTED');
});

test('broken executor => 500 COMPUTATION_FAILED', async () => {
  const { status, json } = await post('/detections', { testName: 'x', pattern: 'broken-executor', runs: 3 });
  assert.equal(status, 500);
  assert.equal(json.error.code, 'COMPUTATION_FAILED');
});

test('unknown test history => 404 NOT_FOUND', async () => {
  const res = await fetch(base + '/reports/ghost');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'NOT_FOUND');
});

test('concurrent round for same test => 409 STATE_CONFLICT', async () => {
  const slow = post('/detections', { testName: 'api-slow', pattern: 'slow-pass', runs: 20 });
  const second = await post('/detections', { testName: 'api-slow', pattern: 'slow-pass', runs: 20 });
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, 'STATE_CONFLICT');
  const first = await slow;
  assert.equal(first.status, 200);
});
