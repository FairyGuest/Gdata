// Diagnostic API tests: boot the real server on an ephemeral port and
// exercise endpoints, including error-category mapping to HTTP statuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/api/server.ts';
import { LintStore } from '../src/state/store.ts';
import { DEFAULT_CONFIG } from '../src/config/config.ts';

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'lint-api-'));
  const config = { ...DEFAULT_CONFIG, dbPath: join(dir, 't.db'), logDir: join(dir, 'logs') };
  const store = new LintStore(config.dbPath);
  const app = buildApp({ config, store });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, store, url, dir };
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as never };
}

test('full API flow: rules -> check -> runs -> diff, plus error mapping', async () => {
  const { app, store, url, dir } = await boot();
  try {
    // seed rules
    const put = await fetch(url + '/rules', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules: [
        { name: 'no-eval', severity: 'error', target: { kind: 'regex', pattern: '\\beval\\s*\\(' } },
        { name: 'no-todo', severity: 'warning', enabled: false, target: { kind: 'regex', pattern: 'TODO' } },
      ] }),
    });
    assert.equal(put.status, 200);

    // enable the disabled rule
    const patch = await fetch(url + '/rules/no-todo', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(patch.status, 200);
    assert.equal(((await patch.json()) as { rule: { enabled: boolean } }).rule.enabled, true);

    // check v1 (persisted)
    const c1 = await post(url, '/check', { files: [{ path: 'a.ts', content: 'eval("1"); // TODO\n' }] });
    assert.equal(c1.status, 200);
    const r1 = c1.body as { runId: number; violations: Array<{ rule: string }> };
    assert.ok(Number.isInteger(r1.runId));
    assert.deepEqual(r1.violations.map((v) => v.rule), ['no-eval', 'no-todo']);

    // check v2 (persisted)
    const c2 = await post(url, '/check', { files: [{ path: 'a.ts', content: 'const x = 1;\n' }] });
    const r2 = c2.body as { runId: number };

    // diff
    const diffRes = await fetch(`${url}/diff?from=${r1.runId}&to=${r2.runId}`);
    const diff = await diffRes.json() as { added: unknown[]; removed: Array<{ rule: string }> };
    assert.equal(diff.added.length, 0);
    assert.deepEqual(diff.removed.map((v) => v.rule).sort(), ['no-eval', 'no-todo']);

    // error mapping: bad rule -> 400 INPUT_ERROR
    const bad = await post(url, '/rules', { name: 'x', severity: 'error', target: { kind: 'regex', pattern: '([' } });
    assert.equal(bad.status, 400);
    assert.equal((bad.body as { error: { category: string } }).error.category, 'INPUT_ERROR');

    // duplicate rule -> 409 STATE_CONFLICT
    await post(url, '/rules', { name: 'dup', severity: 'info', target: { kind: 'regex', pattern: 'a' } });
    const dup = await post(url, '/rules', { name: 'dup', severity: 'info', target: { kind: 'regex', pattern: 'a' } });
    assert.equal(dup.status, 409);
    assert.equal((dup.body as { error: { category: string } }).error.category, 'STATE_CONFLICT');

    // missing run -> 404 NOT_FOUND
    const nf = await fetch(url + '/runs/4242');
    assert.equal(nf.status, 404);
    assert.equal(((await nf.json()) as { error: { category: string } }).error.category, 'NOT_FOUND');

    // malformed check body -> 400 INPUT_ERROR
    const badCheck = await post(url, '/check', { nope: true });
    assert.equal(badCheck.status, 400);
    assert.equal((badCheck.body as { error: { category: string } }).error.category, 'INPUT_ERROR');
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
