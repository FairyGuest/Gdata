// Demo: boots the service on an ephemeral port, ingests two runs, prints the diff.
import { configFromEnv } from '../dist/src/config.js';
import { RingLogger } from '../dist/src/diag/logger.js';
import { ReportStore } from '../dist/src/store/reportStore.js';
import { buildServer } from '../dist/src/http/server.js';

const config = configFromEnv({});
const store = new ReportStore(':memory:', 100);
const logger = new RingLogger(100, false);
const app = buildServer({ config, store, logger });
const address = await app.listen({ port: 0, host: '127.0.0.1' });

const post = (body) => fetch(address + '/reports', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

const base = await post({
  label: 'nightly-1',
  runs: [{ runId: 'run-1', cases: [
    { file: 'auth.test.ts', name: 'logs in', status: 'passed', durationMs: 42 },
    { file: 'auth.test.ts', name: 'rejects bad token', status: 'failed', durationMs: 31 },
    { file: 'cart.test.ts', name: 'adds item', status: 'passed', durationMs: 18 },
  ] }],
});
const head = await post({
  label: 'nightly-2',
  runs: [{ runId: 'run-2', cases: [
    { file: 'auth.test.ts', name: 'logs in', status: 'passed', durationMs: 40 },
    { file: 'auth.test.ts', name: 'rejects bad token', status: 'passed', durationMs: 29 },
    { file: 'cart.test.ts', name: 'adds item', status: 'failed', durationMs: 55 },
    { file: 'cart.test.ts', name: 'empties cart', status: 'skipped', durationMs: 0 },
  ] }],
});

const diff = await fetch(address + '/reports/' + head.id + '/diff?base=' + base.id).then((r) => r.json());
console.log('base report', base.id, base.summary);
console.log('head report', head.id, head.summary);
console.log('diff counts', diff.counts);
for (const entry of diff.entries) {
  console.log(' ', entry.category.padEnd(18), entry.key);
}

await app.close();
store.close();
