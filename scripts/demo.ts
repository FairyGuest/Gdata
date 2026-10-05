import { Store } from '../src/store.ts';
import { createApp } from '../src/server.ts';
import type { AddressInfo } from 'node:net';

const store = new Store(':memory:');
const server = createApp({
  store,
  limits: { maxRuns: 50, maxTestsPerSuite: 200 },
  classifyOptions: { passTarget: 0.99, maxSuggestedRetries: 10 },
  executorOptions: { cmdTimeoutMs: 5000 },
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
console.log('demo server: ' + base);

const suite = {
  suiteId: 'checkout',
  runs: 6,
  tests: [
    { kind: 'scripted', name: 'cart.total', outcomes: ['pass'] },
    { kind: 'scripted', name: 'cart.empty-state', outcomes: ['fail'] },
    { kind: 'scripted', name: 'payment.retry', outcomes: ['pass', 'pass', 'fail'] },
  ],
};

const res = await fetch(base + '/v1/runs', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(suite),
});
const report = await res.json();
console.log('\n=== classifications (round ' + report.roundId + ') ===');
for (const c of report.classifications) {
  console.log(
    c.name.padEnd(18) + c.category.padEnd(13) +
    'conf=' + String(c.confidence).padEnd(7) +
    'pass/fail=' + c.passCount + '/' + c.failCount +
    '  firstFail=' + (c.firstFailureRun ?? '-') +
    '  retries=' + c.suggestedRetries,
  );
  console.log('  reason: ' + c.reason);
}

const hist = await (await fetch(base + '/v1/tests/payment.retry/history')).json();
console.log('\n=== history for payment.retry ===');
console.log(JSON.stringify(hist.rounds, null, 2));

server.close();
store.close();
