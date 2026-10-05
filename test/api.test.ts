import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/http/server.js';
import { ReportStore } from '../src/store/reportStore.js';
import { RingLogger } from '../src/diag/logger.js';
import { configFromEnv } from '../src/config.js';

function makeApp() {
  const config = configFromEnv({});
  const store = new ReportStore(':memory:', 10);
  const logger = new RingLogger(50, false);
  const app = buildServer({ config, store, logger });
  return { app, store };
}

function payload(status: string, name = 't1') {
  return {
    label: 'ci',
    runs: [{ runId: 'run-' + name, cases: [{ file: 'a.ts', name, status, durationMs: 12 }] }],
  };
}

test('ingest, fetch, list, and diff reports end to end', async () => {
  const { app, store } = makeApp();
  try {
    const first = await app.inject({ method: 'POST', url: '/reports', payload: payload('failed') });
    assert.equal(first.statusCode, 201);
    const firstId = first.json().id;
    assert.equal(first.json().summary.failed, 1);

    const second = await app.inject({ method: 'POST', url: '/reports', payload: payload('passed') });
    const secondId = second.json().id;

    const fetched = await app.inject({ method: 'GET', url: '/reports/' + firstId });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.json().cases[0].status, 'failed');

    const list = await app.inject({ method: 'GET', url: '/reports' });
    assert.equal(list.json().reports.length, 2);

    const diff = await app.inject({ method: 'GET', url: '/reports/' + secondId + '/diff?base=' + firstId });
    assert.equal(diff.statusCode, 200);
    assert.equal(diff.json().counts.recovered, 1);

    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.deepEqual(health.json(), { status: 'ok' });
  } finally {
    await app.close();
    store.close();
  }
});

test('error mapping: 400, 404, 409', async () => {
  const { app, store } = makeApp();
  try {
    const bad = await app.inject({ method: 'POST', url: '/reports', payload: { runs: [] } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, 'MISSING_FIELD');

    const missing = await app.inject({ method: 'GET', url: '/reports/999' });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'REPORT_NOT_FOUND');

    const conflict = await app.inject({
      method: 'POST',
      url: '/reports',
      payload: {
        runs: [
          { runId: 'r1', cases: [{ file: 'a', name: 't', status: 'passed', durationMs: 1 }] },
          { runId: 'r2', cases: [{ file: 'a', name: 't', status: 'failed', durationMs: 1 }] },
        ],
      },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, 'STATUS_CONFLICT');

    const badQuery = await app.inject({ method: 'GET', url: '/reports/1/diff' });
    assert.equal(badQuery.statusCode, 400);
    assert.equal(badQuery.json().error.code, 'INVALID_QUERY');
  } finally {
    await app.close();
    store.close();
  }
});
