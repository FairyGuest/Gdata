// One-shot acceptance script: walks every required scenario in a fixed
// order, printing request, response and the judgement for each step.
// Exit code 0 = all scenarios passed; non-zero = first failing scenario.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { buildApp } from '../src/server.ts';
import { RunStore } from '../src/store.ts';
import { summarize } from '../src/stats.ts';

let failures = 0;

function step(name: string, fn: () => void | Promise<void>): Promise<void> | void {
  const run = async () => {
    process.stdout.write('[accept] ' + name + ' ... ');
    try {
      await fn();
      console.log('PASS');
    } catch (err) {
      failures++;
      console.log('FAIL');
      console.log('  reason: ' + (err instanceof Error ? err.message : String(err)));
    }
  };
  return run();
}

// Deterministic target: /ok -> 200, /mixed alternates 200/500, /hang -> 500ms delay.
let mixedHits = 0;
const target: Server = createServer((req, res) => {
  if (req.url === '/mixed') {
    mixedHits++;
    res.writeHead(mixedHits % 2 === 1 ? 200 : 500); res.end('m');
  } else if (req.url === '/hang') {
    setTimeout(() => { res.writeHead(200); res.end('slow'); }, 500);
  } else {
    res.writeHead(200); res.end('ok');
  }
});
await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
const targetUrl = 'http://127.0.0.1:' + (target.address() as { port: number }).port;
console.log('[accept] target server: ' + targetUrl);

const app = buildApp({ store: new RunStore(':memory:'), log: (e, f) => console.log('  [log]', e, JSON.stringify(f)) });
const base = await app.listen(0, '127.0.0.1');
console.log('[accept] service: ' + base);

const post = (payload: unknown) =>
  fetch(base + '/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

// --- Scenario 1: percentile boundary computation (hand-computed reference) ---
await step('S1 latency percentile boundary values', () => {
  const s = summarize([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  console.log('');
  console.log('  computed: ' + JSON.stringify(s));
  // nearest-rank reference, computed by hand:
  assert.equal(s.p50, 50);
  assert.equal(s.p90, 90);
  assert.equal(s.p99, 100);
  assert.equal(s.min, 10);
  assert.equal(s.max, 100);
  assert.equal(s.mean, 55);
});

// --- Scenario 2: low concurrency, all requests succeed ---
let okRunId = 0;
await step('S2 low-concurrency all-success run', async () => {
  const payload = { url: targetUrl + '/ok', requests: 10, concurrency: 2 };
  const res = await post(payload);
  const body = await res.json();
  console.log('');
  console.log('  request:  POST /runs ' + JSON.stringify(payload));
  console.log('  response: ' + res.status + ' succeeded=' + body.succeeded + ' failed=' + body.failed + ' rps=' + body.throughputRps?.toFixed(1));
  assert.equal(res.status, 201);
  assert.equal(body.succeeded, 10);
  assert.equal(body.failed, 0);
  assert.equal(body.outcomes.length, 10);
  assert.equal(body.successLatency.count, 10);
  assert.equal(body.failureLatency.count, 0);
  assert.ok(body.throughputRps > 0);
  okRunId = body.id;
});

// --- Scenario 3: mixed success/failure with distinct failure categories ---
await step('S3 mixed success/failure classification', async () => {
  const payload = { url: targetUrl + '/mixed', requests: 10, concurrency: 3 };
  const res = await post(payload);
  const body = await res.json();
  console.log('');
  console.log('  request:  POST /runs ' + JSON.stringify(payload));
  console.log('  response: ' + res.status + ' succeeded=' + body.succeeded + ' failed=' + body.failed + ' byKind=' + JSON.stringify(body.failuresByKind));
  assert.equal(res.status, 201);
  assert.equal(body.succeeded, 5);
  assert.equal(body.failed, 5);
  assert.equal(body.failuresByKind.http_status, 5);
  assert.equal(body.successLatency.count, 5);
  assert.equal(body.failureLatency.count, 5);
});

// --- Scenario 4: timeout failures classified separately ---
await step('S4 timeout failure classification', async () => {
  const payload = { url: targetUrl + '/hang', requests: 2, concurrency: 2, timeoutMs: 100 };
  const res = await post(payload);
  const body = await res.json();
  console.log('');
  console.log('  request:  POST /runs ' + JSON.stringify(payload));
  console.log('  response: ' + res.status + ' byKind=' + JSON.stringify(body.failuresByKind));
  assert.equal(res.status, 201);
  assert.equal(body.succeeded, 0);
  assert.equal(body.failuresByKind.timeout, 2);
});

// --- Scenario 5: input error semantics ---
await step('S5 invalid input returns 400 INPUT_ERROR', async () => {
  const res = await post({ url: 'not-a-url', requests: 0 });
  const body = await res.json();
  console.log('');
  console.log('  request:  POST /runs {url:"not-a-url",requests:0}');
  console.log('  response: ' + res.status + ' ' + JSON.stringify(body.error));
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'INPUT_ERROR');
});

// --- Scenario 6: unknown run id ---
await step('S6 unknown run id returns 404 NOT_FOUND', async () => {
  const res = await fetch(base + '/runs/424242');
  const body = await res.json();
  console.log('');
  console.log('  response: ' + res.status + ' ' + JSON.stringify(body.error));
  assert.equal(res.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

// --- Scenario 7: history query by target URL ---
await step('S7 history query by url returns persisted runs', async () => {
  const res = await fetch(base + '/runs?url=' + encodeURIComponent(targetUrl + '/ok'));
  const body = await res.json();
  console.log('');
  console.log('  response: runs=' + body.runs.length + ' first=' + JSON.stringify(body.runs[0]));
  assert.equal(res.status, 200);
  assert.ok(body.runs.length >= 1);
  assert.equal(body.runs[0].id, okRunId);
});

await app.close();
await new Promise((r) => target.close(r));

if (failures > 0) {
  console.error('[accept] ' + failures + ' scenario(s) FAILED');
  process.exit(1);
}
console.log('[accept] all scenarios passed');
