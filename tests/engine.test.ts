import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { runLoadTest } from '../src/engine.ts';
import { parseRunConfig } from '../src/config.ts';

interface Target { server: Server; url: string }

// Target with deterministic behaviour per path:
//   /ok    -> 200 immediately
//   /fail  -> 500 immediately
//   /mixed -> alternates 200 / 500 per request
//   /hang  -> responds after 500ms (used with a short client timeout)
async function makeTarget(): Promise<Target & { mixedCount: () => number }> {
  let mixed = 0;
  const server = createServer((req, res) => {
    if (req.url === '/fail') {
      res.writeHead(500); res.end('bad');
    } else if (req.url === '/mixed') {
      mixed++;
      res.writeHead(mixed % 2 === 1 ? 200 : 500); res.end('m');
    } else if (req.url === '/hang') {
      setTimeout(() => { res.writeHead(200); res.end('slow'); }, 500);
    } else {
      res.writeHead(200); res.end('ok');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { server, url: 'http://127.0.0.1:' + port, mixedCount: () => mixed };
}

const cfg = (url: string, over: Record<string, unknown> = {}) =>
  parseRunConfig({ url, ...over });

async function withTarget(fn: (t: Target & { mixedCount: () => number }) => Promise<void>): Promise<void> {
  const t = await makeTarget();
  try { await fn(t); } finally { await new Promise((r) => t.server.close(r)); }
}

test('low concurrency: every request succeeds and no outcome is lost', async () => {
  await withTarget(async (t) => {
    const r = await runLoadTest(cfg(t.url + '/ok', { requests: 20, concurrency: 2 }));
    assert.equal(r.total, 20);
    assert.equal(r.succeeded, 20);
    assert.equal(r.failed, 0);
    assert.equal(r.outcomes.length, 20);
    assert.deepEqual(r.outcomes.map((o) => o.seq).sort((a, b) => a - b),
      Array.from({ length: 20 }, (_, i) => i));
    assert.ok(r.outcomes.every((o) => o.ok && o.statusCode === 200));
    assert.equal(r.statusCodes['200'], 20);
    assert.equal(r.successLatency.count, 20);
    assert.equal(r.failureLatency.count, 0);
    assert.ok(r.throughputRps > 0);
    assert.ok(r.successLatency.max >= r.successLatency.min);
  });
});

test('mixed success/failure: categories counted separately', async () => {
  await withTarget(async (t) => {
    const r = await runLoadTest(cfg(t.url + '/mixed', { requests: 10, concurrency: 3 }));
    assert.equal(r.total, 10);
    assert.equal(r.succeeded + r.failed, 10);
    assert.equal(r.succeeded, 5); // odd-numbered hits get 200
    assert.equal(r.failed, 5);
    assert.equal(r.failuresByKind.http_status, 5);
    assert.equal(r.failuresByKind.timeout, 0);
    assert.equal(r.failuresByKind.connection, 0);
    assert.equal(r.successLatency.count, 5);
    assert.equal(r.failureLatency.count, 5);
    assert.equal(r.statusCodes['200'], 5);
    assert.equal(r.statusCodes['500'], 5);
    // failed outcomes carry their kind and reason
    const failed = r.outcomes.filter((o) => !o.ok);
    assert.ok(failed.every((o) => o.failureKind === 'http_status' && o.error !== null));
  });
});

test('non-2xx responses are failures, not successes', async () => {
  await withTarget(async (t) => {
    const r = await runLoadTest(cfg(t.url + '/fail', { requests: 6, concurrency: 2 }));
    assert.equal(r.succeeded, 0);
    assert.equal(r.failed, 6);
    assert.equal(r.failuresByKind.http_status, 6);
    assert.equal(r.successLatency.count, 0);
    assert.equal(r.failureLatency.count, 6);
  });
});

test('client timeout is classified as timeout failure', async () => {
  await withTarget(async (t) => {
    const r = await runLoadTest(cfg(t.url + '/hang', { requests: 3, concurrency: 2, timeoutMs: 100 }));
    assert.equal(r.succeeded, 0);
    assert.equal(r.failed, 3);
    assert.equal(r.failuresByKind.timeout, 3);
    assert.equal(r.failuresByKind.connection, 0);
  });
});

test('unreachable host is classified as connection failure', async () => {
  const r = await runLoadTest(cfg('http://127.0.0.1:1/', { requests: 3, concurrency: 2, timeoutMs: 500 }));
  assert.equal(r.failed, 3);
  assert.equal(r.failuresByKind.connection, 3);
  assert.equal(r.failuresByKind.timeout, 0);
});

test('intervalMs paces requests per worker', async () => {
  await withTarget(async (t) => {
    const r = await runLoadTest(cfg(t.url + '/ok', { requests: 3, concurrency: 1, intervalMs: 60 }));
    assert.equal(r.succeeded, 3);
    // 2 intervals between 3 sequential requests
    assert.ok(r.durationMs >= 110, 'duration ' + r.durationMs + ' should be >= 110ms');
  });
});
