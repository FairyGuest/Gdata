import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { buildApp } from '../src/server.ts';
import { RunStore } from '../src/store.ts';

async function makeTarget(handler?: (req: unknown, res: { writeHead: (n: number) => void; end: (s?: string) => void }) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler ?? ((_, res) => { res.writeHead(200); res.end('ok'); }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { server, url: 'http://127.0.0.1:' + port };
}

test('POST /runs executes, persists and is queryable by url and time', async () => {
  const { server, url } = await makeTarget();
  const store = new RunStore(':memory:');
  const app = buildApp({ store, log: () => {} });
  try {
    const before = new Date(Date.now() - 1000).toISOString();
    const res = await app.inject({ method: 'POST', url: '/runs', payload: { url, requests: 5, concurrency: 2 } });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.ok(body.id >= 1);
    assert.equal(body.succeeded, 5);
    assert.equal(body.failed, 0);
    assert.ok(body.throughputRps > 0);

    const byUrl = await app.inject({ method: 'GET', url: '/runs?url=' + encodeURIComponent(url) });
    assert.equal(byUrl.json().runs.length, 1);

    const byTime = await app.inject({ method: 'GET', url: '/runs?from=' + encodeURIComponent(before) });
    assert.equal(byTime.json().runs.length, 1);

    const noMatch = await app.inject({ method: 'GET', url: '/runs?url=' + encodeURIComponent('http://nope.invalid/') });
    assert.equal(noMatch.json().runs.length, 0);

    const one = await app.inject({ method: 'GET', url: '/runs/' + body.id });
    assert.equal(one.statusCode, 200);
    assert.equal(one.json().result.config.url, url);
    assert.equal(one.json().result.outcomes.length, 5);
  } finally {
    store.close();
    await new Promise((r) => server.close(r));
  }
});

test('POST /runs input errors are 400 INPUT_ERROR with reasons', async () => {
  const app = buildApp({ store: new RunStore(':memory:'), log: () => {} });
  const cases: unknown[] = [
    {},
    { url: 'not-a-url' },
    { url: 'ftp://x/' },
    { url: 'http://x/', requests: 0 },
    { url: 'http://x/', concurrency: -1 },
    { url: 'http://x/', requests: 100001 },
    { url: 'http://x/', method: 'FOO' },
  ];
  for (const payload of cases) {
    const res = await app.inject({ method: 'POST', url: '/runs', payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.json().error.code, 'INPUT_ERROR');
  }
});

test('GET /runs/:id unknown id is 404 NOT_FOUND', async () => {
  const app = buildApp({ store: new RunStore(':memory:'), log: () => {} });
  const res = await app.inject({ method: 'GET', url: '/runs/999' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'NOT_FOUND');
});

test('concurrent run request is 409 STATE_CONFLICT', async () => {
  const { server, url } = await makeTarget((_, res) => {
    setTimeout(() => { res.writeHead(200); res.end('ok'); }, 80);
  });
  const app = buildApp({ store: new RunStore(':memory:'), log: () => {} });
  try {
    const slow = app.inject({ method: 'POST', url: '/runs', payload: { url, requests: 4, concurrency: 1 } });
    await new Promise((r) => setTimeout(r, 30)); // let the first run start
    const second = await app.inject({ method: 'POST', url: '/runs', payload: { url, requests: 1 } });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error.code, 'STATE_CONFLICT');
    const first = await slow;
    assert.equal(first.statusCode, 201);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
