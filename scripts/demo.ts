// Local demo: spins up a target server and the service, runs one load test
// through the HTTP API, and prints the latency distribution + throughput.
import { createServer } from 'node:http';
import { buildApp } from '../src/server.ts';
import { RunStore } from '../src/store.ts';

const target = createServer((_, res) => {
  setTimeout(() => { res.writeHead(200); res.end('ok'); }, Math.random() * 20);
});
await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
const targetUrl = 'http://127.0.0.1:' + (target.address() as { port: number }).port;

const app = buildApp({ store: new RunStore(':memory:') });
const base = await app.listen(0, '127.0.0.1');
console.log('service: ' + base + '  target: ' + targetUrl);

const res = await fetch(base + '/runs', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: targetUrl, requests: 100, concurrency: 10, intervalMs: 5 }),
});
const run = await res.json();
const fmt = (s: Record<string, number>) => JSON.stringify({
  count: s.count, min: +s.min.toFixed(1), p50: +s.p50.toFixed(1),
  p90: +s.p90.toFixed(1), p99: +s.p99.toFixed(1), max: +s.max.toFixed(1),
  mean: +s.mean.toFixed(1),
});
console.log('run id:        ', run.id);
console.log('succeeded:     ', run.succeeded, ' failed:', run.failed);
console.log('duration ms:   ', run.durationMs);
console.log('throughput rps:', run.throughputRps.toFixed(1));
console.log('success lat ms:', fmt(run.successLatency));
console.log('failure lat ms:', fmt(run.failureLatency));

const history = await (await fetch(base + '/runs?url=' + encodeURIComponent(targetUrl))).json();
console.log('history rows for target:', history.runs.length);

await app.close();
await new Promise((r) => target.close(r));
