// Acceptance walkthrough: boots the service in-process and exercises every
// scenario in a fixed order, printing request, response, and verdict per step.
// Exit code 0 = all steps passed, 1 = at least one step failed.
import { configFromEnv } from '../dist/src/config.js';
import { RingLogger } from '../dist/src/diag/logger.js';
import { ReportStore } from '../dist/src/store/reportStore.js';
import { buildServer } from '../dist/src/http/server.js';

const config = configFromEnv({});
const store = new ReportStore(':memory:', 100);
const logger = new RingLogger(100, false);
const app = buildServer({ config, store, logger });
const address = await app.listen({ port: 0, host: '127.0.0.1' });

let failures = 0;
const short = (value) => {
  const text = JSON.stringify(value);
  return text.length > 160 ? text.slice(0, 157) + '...' : text;
};

async function step(title, fn) {
  process.stdout.write('STEP  ' + title + '\n');
  try {
    await fn();
    process.stdout.write('PASS  ' + title + '\n\n');
  } catch (error) {
    failures += 1;
    process.stdout.write('FAIL  ' + title + ' -> ' + error.message + '\n\n');
  }
}

function expect(condition, message) {
  if (!condition) throw new Error('assertion failed: ' + message);
}

async function req(method, path, body) {
  const res = await fetch(address + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  process.stdout.write('  req  ' + method + ' ' + path + (body === undefined ? '' : ' ' + short(body)) + '\n');
  process.stdout.write('  res  ' + res.status + ' ' + short(json) + '\n');
  return { status: res.status, body: json };
}

const c = (file, name, status, durationMs) => ({ file, name, status, durationMs });
const run = (label, runId, cases) => ({ label, runs: [{ runId, cases }] });

let purePassId;
let mixedId;

try {
  await step('health check', async () => {
    const res = await req('GET', '/health');
    expect(res.status === 200 && res.body.status === 'ok', 'service healthy');
  });

  await step('scenario 1: pure-pass run aggregates to all-passed summary', async () => {
    const res = await req('POST', '/reports', run('pure-pass', 'run-pass-1', [
      c('auth.test.ts', 'logs in', 'passed', 42),
      c('auth.test.ts', 'refreshes token', 'passed', 35),
      c('cart.test.ts', 'adds item', 'passed', 18),
    ]));
    purePassId = res.body.id;
    expect(res.status === 201, 'created');
    expect(res.body.summary.total === 3 && res.body.summary.passed === 3, '3 passed');
    expect(res.body.summary.failed === 0 && res.body.summary.skipped === 0, 'no failures or skips');
    expect(res.body.summary.totalDurationMs === 95, 'durations summed');
  });

  await step('scenario 2: pure-fail run aggregates to all-failed summary', async () => {
    const res = await req('POST', '/reports', run('pure-fail', 'run-fail-1', [
      c('auth.test.ts', 'logs in', 'failed', 40),
      c('cart.test.ts', 'adds item', 'failed', 22),
    ]));
    expect(res.status === 201, 'created');
    expect(res.body.summary.failed === 2 && res.body.summary.passed === 0, '2 failed');
  });

  await step('scenario 3: mixed run merges statuses and skips', async () => {
    const res = await req('POST', '/reports', run('mixed', 'run-mixed-1', [
      c('auth.test.ts', 'logs in', 'passed', 41),
      c('auth.test.ts', 'rejects bad token', 'failed', 31),
      c('cart.test.ts', 'adds item', 'passed', 18),
      c('cart.test.ts', 'empties cart', 'skipped', 0),
      c('pay.test.ts', 'pays', 'failed', 55),
    ]));
    mixedId = res.body.id;
    expect(res.status === 201, 'created');
    const s = res.body.summary;
    expect(s.total === 5 && s.passed === 2 && s.failed === 2 && s.skipped === 1, 'mixed counts');
  });

  await step('scenario 4: filter and sort cases by status, file, and duration', async () => {
    const failed = await req('GET', '/reports/' + mixedId + '?status=failed&sort=durationMs&order=desc');
    expect(failed.status === 200, 'query ok');
    const keys = failed.body.cases.map((x) => x.key);
    expect(JSON.stringify(keys) === JSON.stringify(['pay.test.ts::pays', 'auth.test.ts::rejects bad token']),
      'failed cases sorted by duration desc, got ' + JSON.stringify(keys));

    const byFile = await req('GET', '/reports/' + mixedId + '?file=cart&sort=name');
    expect(byFile.body.cases.length === 2, 'file substring filter');

    const badSort = await req('GET', '/reports/' + mixedId + '?sort=bogus');
    expect(badSort.status === 400 && badSort.body.error.code === 'INVALID_QUERY', 'invalid sort rejected');
  });

  await step('scenario 5: diff detects new, persistent, recovered, and passed', async () => {
    const head = await req('POST', '/reports', run('mixed-2', 'run-mixed-2', [
      c('auth.test.ts', 'logs in', 'failed', 44),        // was passed -> new_failure
      c('auth.test.ts', 'rejects bad token', 'failed', 30), // was failed -> persistent_failure
      c('cart.test.ts', 'adds item', 'passed', 19),      // stayed passed
      c('pay.test.ts', 'pays', 'passed', 50),            // was failed -> recovered
      c('cart.test.ts', 'empties cart', 'skipped', 0),   // stayed skipped
    ]));
    expect(head.status === 201, 'head created');
    const diff = await req('GET', '/reports/' + head.body.id + '/diff?base=' + mixedId);
    expect(diff.status === 200, 'diff ok');
    const counts = diff.body.counts;
    expect(counts.new_failure === 1, 'one new failure');
    expect(counts.persistent_failure === 1, 'one persistent failure');
    expect(counts.recovered === 1, 'one recovered');
    expect(counts.passed === 1, 'one still passing');
    const order = diff.body.entries.map((e) => e.category);
    const expected = ['new_failure', 'persistent_failure', 'recovered', 'passed', 'skipped'];
    expect(JSON.stringify(order) === JSON.stringify(expected),
      'entries ordered new>persistent>recovered>passed, got ' + JSON.stringify(order));
  });

  await step('scenario 6: error semantics are distinguishable', async () => {
    const unknown = await req('POST', '/reports', run('bad', 'run-bad', [c('f', 'n', 'bogus', 1)]));
    expect(unknown.status === 400 && unknown.body.error.code === 'UNKNOWN_STATUS', 'unknown status -> 400');

    const conflict = await req('POST', '/reports', {
      runs: [
        { runId: 'r1', cases: [c('f', 'n', 'passed', 1)] },
        { runId: 'r2', cases: [c('f', 'n', 'failed', 1)] },
      ],
    });
    expect(conflict.status === 409 && conflict.body.error.code === 'STATUS_CONFLICT', 'conflict -> 409');

    const missing = await req('GET', '/reports/4242');
    expect(missing.status === 404 && missing.body.error.code === 'REPORT_NOT_FOUND', 'missing -> 404');

    const noBase = await req('GET', '/reports/' + mixedId + '/diff');
    expect(noBase.status === 400 && noBase.body.error.code === 'INVALID_QUERY', 'missing base -> 400');
  });

  await step('scenario 7: diagnostic log endpoint retains run context', async () => {
    const res = await req('GET', '/diag/logs?limit=50');
    expect(res.status === 200 && Array.isArray(res.body.entries), 'log entries returned');
    const ingested = res.body.entries.filter((e) => e.message.startsWith('ingested report'));
    expect(ingested.length >= 4, 'ingest events logged, got ' + ingested.length);
    const warned = res.body.entries.some((e) => e.level === 'warn');
    expect(warned, 'rejected requests logged as warnings');
  });

  await step('scenario 8: pure-pass report diffs clean against itself-equivalent run', async () => {
    const again = await req('POST', '/reports', run('pure-pass-2', 'run-pass-2', [
      c('auth.test.ts', 'logs in', 'passed', 42),
      c('auth.test.ts', 'refreshes token', 'passed', 35),
      c('cart.test.ts', 'adds item', 'passed', 18),
    ]));
    const diff = await req('GET', '/reports/' + again.body.id + '/diff?base=' + purePassId);
    expect(diff.body.counts.passed === 3, 'all still passed');
    expect(diff.body.counts.new_failure === 0 && diff.body.counts.recovered === 0, 'no transitions');
  });
} finally {
  await app.close();
  store.close();
}

if (failures > 0) {
  console.error('acceptance FAILED: ' + failures + ' scenario(s) failed');
  process.exit(1);
}
console.log('acceptance OK: all scenarios passed');

