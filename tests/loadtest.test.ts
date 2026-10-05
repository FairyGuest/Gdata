import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { summarize, percentile } from '../src/stats.ts';
import { runLoadTest } from '../src/loadtest.ts';

test('summarize computes percentiles', () => {
  const s = summarize([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(s.count, 10);
  assert.equal(s.min, 10);
  assert.equal(s.max, 100);
  assert.equal(s.mean, 55);
  assert.equal(s.p50, 50);
  assert.equal(s.p99, 100);
});

test('percentile handles empty and single values', () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([5], 99), 5);
});

async function withTarget(fn: (url: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/slow') {
      setTimeout(() => { res.writeHead(200); res.end('ok'); }, 30);
    } else if (req.url === '/fail') {
      res.writeHead(500); res.end('bad');
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    await fn('http://127.0.0.1:' + port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('runLoadTest completes all requests and records stats', async () => {
  await withTarget(async (url) => {
    const result = await runLoadTest({ url: url + '/', requests: 20, concurrency: 5 });
    assert.equal(result.completed, 20);
    assert.equal(result.errors, 0);
    assert.equal(result.latency.count, 20);
    assert.equal(result.statusCodes['200'], 20);
    assert.ok(result.latency.max >= result.latency.min);
  });
});

test('runLoadTest counts error status codes', async () => {
  await withTarget(async (url) => {
    const result = await runLoadTest({ url: url + '/fail', requests: 4, concurrency: 2 });
    assert.equal(result.statusCodes['500'], 4);
    assert.equal(result.errors, 0);
  });
});

test('runLoadTest records network errors', async () => {
  const result = await runLoadTest({ url: 'http://127.0.0.1:1/', requests: 3, concurrency: 2, timeoutMs: 500 });
  assert.equal(result.errors, 3);
  assert.equal(result.completed, 0);
});
