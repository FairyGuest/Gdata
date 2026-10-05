// HTTP diagnostics API tests: routes, error envelope, error categories.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/http.ts';
import { MutationKernel } from '../src/kernel.ts';
import { MutationStore } from '../src/store.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => path.join(root, 'fixtures', name);

const withServer = async (fn) => {
  const kernel = new MutationKernel({ ...DEFAULT_CONFIG, workspaceRoot: path.join(root, '.test-workspaces') });
  const store = new MutationStore(':memory:');
  const server = createServer(kernel, store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = 'http://127.0.0.1:' + port;
  try {
    await fn(base, store);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
};

const post = (base, body) =>
  fetch(base + '/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('health endpoint reports ok', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/health');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });
});

test('POST /runs executes a run and persists it for later queries', async () => {
  await withServer(async (base) => {
    const res = await post(base, { projectDir: fixture('killed-project'), sourceFile: 'src/calc.js' });
    assert.equal(res.status, 201);
    const report = await res.json();
    assert.equal(report.score, 1);
    assert.equal(report.killed, 1);

    const fetched = await fetch(base + '/runs/' + report.runId);
    assert.equal(fetched.status, 200);
    assert.equal((await fetched.json()).runId, report.runId);

    const mutants = await fetch(base + '/mutants?file=' + encodeURIComponent('src/calc.js'));
    const rows = (await mutants.json()).mutants;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'killed');

    const list = await fetch(base + '/runs');
    assert.ok((await list.json()).runs.some((r) => r.runId === report.runId));
  });
});

test('invalid JSON body returns INPUT_ERROR envelope', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/runs', { method: 'POST', body: '{not json' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.category, 'INPUT_ERROR');
  });
});

test('missing projectDir returns INPUT_ERROR, not success', async () => {
  await withServer(async (base) => {
    const res = await post(base, { projectDir: '/does/not/exist', sourceFile: 'x.js' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.category, 'INPUT_ERROR');
  });
});

test('excessive timeoutMs returns RESOURCE_EXHAUSTED', async () => {
  await withServer(async (base) => {
    const res = await post(base, {
      projectDir: fixture('killed-project'), sourceFile: 'src/calc.js', timeoutMs: 999999,
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.category, 'RESOURCE_EXHAUSTED');
  });
});

test('unknown run id and unknown route are 404 INPUT_ERROR', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/runs/R-nope');
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.category, 'INPUT_ERROR');
    const res2 = await fetch(base + '/nope');
    assert.equal(res2.status, 404);
  });
});

test('unknown mutator filter is rejected as INPUT_ERROR', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/mutants?mutator=Bogus');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.category, 'INPUT_ERROR');
  });
});
