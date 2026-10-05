import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, listen } from '../src/api/server.ts';
import { Store } from '../src/state/store.ts';
import type { Server } from 'node:http';

let server: Server;
let base: string;
const config = { port: 0, dbPath: ':memory:', limits: { maxSourceBytes: 1024, maxRules: 10, maxMatchesPerRule: 100 } };

before(async () => {
  server = buildServer(new Store(':memory:'), config);
  const port = await listen(server, 0);
  base = 'http://127.0.0.1:' + port;
});

after(() => server.close());

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
};

test('full flow: rules -> check -> diff, plus error categories', async () => {
  let r = await call('PUT', '/rules', { rules: [
    { name: 'no-eval', enabled: true, severity: 'error', message: 'no eval', match: { kind: 'regex', pattern: 'eval\\(' } },
    { name: 'no-console', enabled: true, severity: 'warning', message: 'no console', match: { kind: 'regex', pattern: 'console\\.log' } },
  ] });
  assert.equal(r.status, 200);
  assert.equal((r.json as { count: number }).count, 2);

  r = await call('POST', '/check', { file: 'a.ts', source: 'eval("1");\nconsole.log("x");\n' });
  assert.equal(r.status, 200);
  const run1 = r.json as { runId: string; violations: Array<{ rule: string }> };
  assert.equal(run1.violations.length, 2);
  assert.equal(run1.violations[0].rule, 'no-eval');

  r = await call('POST', '/check', { file: 'a.ts', source: 'const y = 0;\nconsole.log("x");\n' });
  const run2 = r.json as { runId: string };

  r = await call('GET', '/diff?from=' + run1.runId + '&to=' + run2.runId);
  const diff = r.json as { added: unknown[]; removed: Array<{ rule: string }> };
  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.removed[0].rule, 'no-eval');

  r = await call('PATCH', '/rules/no-console', { enabled: false });
  assert.equal(r. status, 200);
  r = await call('POST', '/check', { file: 'a.ts', source: 'console.log("x");\n' });
  assert.equal((r.json as { violations: unknown[] }).violations.length, 0);

  r = await call('PUT', '/rules', { rules: [
    { name: 'bad', enabled: true, severity: 'error', message: 'm', match: { kind: 'regex', pattern: '([' } },
  ] });
  assert.equal(r.status, 400);
  assert.equal((r.json as { error: { category: string } }).error.category, 'INPUT_ERROR');

  r = await call('POST', '/rules', { rule: { name: 'no-eval', enabled: true, severity: 'info', message: 'm', match: { kind: 'regex', pattern: 'x' } } });
  assert.equal(r.status, 409);
  assert.equal((r.json as { error: { category: string } }).error.category, 'STATE_CONFLICT');

  r = await call('GET', '/runs/run-does-not-exist');
  assert.equal(r.status, 404);
  assert.equal((r.json as { error: { category: string } }).error.category, 'NOT_FOUND');

  r = await call('POST', '/check', { file: 'big.ts', source: 'x'.repeat(5000) });
  assert.equal(r.status, 413);
  assert.equal((r.json as { error: { category: string } }).error.category, 'RESOURCE_EXHAUSTED');

  r = await call('POST', '/check', { file: 'a.ts' });
  assert.equal(r.status, 400);
  assert.equal((r.json as { error: { code: string } }).error.code, 'CHECK_ARGS_INVALID');
});

