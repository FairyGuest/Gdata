// Acceptance drill: boots the real service and walks every scenario in a
// fixed order, printing request / response / verdict for each step.
// Exit 0 iff every step passes; exit 1 naming the failed scenarios otherwise.
import { createServer, type RunningServer } from '../src/api/server.ts';
import type { ServiceConfig } from '../src/config.ts';

const config: ServiceConfig = {
  port: 0, dbPath: ':memory:', defaultRuns: 5, maxRuns: 100,
  targetReliability: 0.99, maxRetries: 5,
};

let server: RunningServer;
let base = '';
const failures: string[] = [];
let step = 0;

function verdict(name: string, ok: boolean, extra = ''): void {
  step += 1;
  console.log(`  verdict: ${ok ? 'PASS' : 'FAIL'}${extra ? ' - ' + extra : ''}`);
  console.log(`[step ${step}] ${ok ? 'OK  ' : 'BAD '} ${name}`);
  if (!ok) failures.push(name);
}

function check(cond: boolean): asserts cond {
  if (!cond) throw new Error('assertion failed');
}

async function req(method: string, path: string, body?: unknown, rawBody?: string): Promise<{ status: number; json: any }> {
  console.log(`  request:  ${method} ${path}${body !== undefined ? ' body=' + JSON.stringify(body) : ''}`);
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const json = await res.json();
  console.log(`  response: ${res.status} ${JSON.stringify(json).slice(0, 400)}`);
  return { status: res.status, json };
}

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n--- scenario: ${name}`);
  try {
    await fn();
    verdict(name, true);
  } catch (err) {
    verdict(name, false, err instanceof Error ? err.message : String(err));
  }
}

server = await createServer(config, () => {});
base = `http://127.0.0.1:${server.port}`;
console.log(`acceptance server on ${base}`);

await scenario('health check', async () => {
  const r = await req('GET', '/health');
  check(r.status === 200 && r.json.status === 'ok');
});

await scenario('all-pass test => stable_pass, confidence 0.9688, 0 retries', async () => {
  const r = await req('POST', '/detections', { testName: 'acc-pass', pattern: 'always-pass', runs: 5 });
  check(r.status === 200);
  check(r.json.report.classification === 'stable_pass');
  check(r.json.report.confidence === 0.9688);
  check(r.json.report.suggestedRetries === 0);
  check(r.json.runs.length === 5 && r.json.runs.every((x: any) => x.outcome === 'pass'));
});

await scenario('all-fail test => stable_fail, confidence 0.9688', async () => {
  const r = await req('POST', '/detections', { testName: 'acc-fail', pattern: 'always-fail', runs: 5 });
  check(r.status === 200);
  check(r.json.report.classification === 'stable_fail');
  check(r.json.report.confidence === 0.9688);
  check(r.json.report.suggestedRetries === 0);
});

await scenario('alternating test => flaky, 3/3 distribution, first failure run #2, confidence 0.9844, 5 retries', async () => {
  const r = await req('POST', '/detections', { testName: 'acc-flaky', pattern: 'alternate', runs: 6 });
  check(r.status === 200);
  const rep = r.json.report;
  check(rep.classification === 'flaky');
  check(rep.distribution.passes === 3 && rep.distribution.failures === 3);
  check(rep.firstFailureRun === 2);
  check(rep.confidence === 0.9844);
  check(rep.suggestedRetries === 5);
  check(typeof rep.reasoning === 'string' && rep.reasoning.includes('first failure at run #2'));
});

await scenario('second round + cross-round trend from SQLite', async () => {
  const again = await req('POST', '/detections', { testName: 'acc-flaky', pattern: 'alternate', runs: 6 });
  check(again.status === 200);
  const trend = await req('GET', '/reports/acc-flaky/trend');
  check(trend.status === 200);
  check(trend.json.rounds === 2 && trend.json.flakyRounds === 2);
  check(trend.json.entries[0].classification === 'flaky' && trend.json.entries[1].classification === 'flaky');
  const latest = await req('GET', '/reports/acc-flaky');
  check(latest.status === 200 && latest.json.report.roundId === again.json.report.roundId);
});

await scenario('invalid inputs => 400 INPUT_ERROR', async () => {
  for (const body of [
    { testName: '', pattern: 'always-pass' },
    { testName: 'x', pattern: 'always-pass', runs: 0 },
    { testName: 'x', pattern: 'nope' },
    { pattern: 'always-pass' },
  ]) {
    const r = await req('POST', '/detections', body);
    check(r.status === 400 && r.json.error.code === 'INPUT_ERROR');
  }
  const bad = await req('POST', '/detections', undefined, '{not json');
  check(bad.status === 400 && bad.json.error.code === 'INPUT_ERROR');
});

await scenario('run budget exceeded => 503 RESOURCE_EXHAUSTED', async () => {
  const r = await req('POST', '/detections', { testName: 'acc-greedy', pattern: 'always-pass', runs: 100000 });
  check(r.status === 503 && r.json.error.code === 'RESOURCE_EXHAUSTED');
});

await scenario('executor contract violation => 500 COMPUTATION_FAILED', async () => {
  const r = await req('POST', '/detections', { testName: 'acc-broken', pattern: 'broken-executor', runs: 3 });
  check(r.status === 500 && r.json.error.code === 'COMPUTATION_FAILED');
});

await scenario('concurrent round for same test => 409 STATE_CONFLICT', async () => {
  const slow = req('POST', '/detections', { testName: 'acc-slow', pattern: 'slow-pass', runs: 20 });
  const second = await req('POST', '/detections', { testName: 'acc-slow', pattern: 'slow-pass', runs: 20 });
  check(second.status === 409 && second.json.error.code === 'STATE_CONFLICT');
  const first = await slow;
  check(first.status === 200);
});

await scenario('unknown test history => 404 NOT_FOUND', async () => {
  const r = await req('GET', '/reports/never-ran');
  check(r.status === 404 && r.json.error.code === 'NOT_FOUND');
});

await server.close();

console.log(`\n========================================`);
if (failures.length === 0) {
  console.log(`ACCEPTANCE PASSED: ${step}/${step} scenarios ok`);
  process.exit(0);
} else {
  console.log(`ACCEPTANCE FAILED (${failures.length}/${step}):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
