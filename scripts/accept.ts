// One-shot acceptance drill. Exercises every binding-semantic scenario in a
// fixed order against a real HTTP server (ephemeral port, temp database),
// printing request, response and verdict per step. Exit 0 iff all pass.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logging.js';
import { SecretStore } from '../src/state/store.js';
import { SecretService } from '../src/core/service.js';
import { buildServer } from '../src/http/server.js';

const runId = 'accept-' + randomUUID().slice(0, 8);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esb-accept-'));
const config = { ...loadConfig(), dbPath: path.join(tmpDir, 'accept.db'), logFile: path.join(tmpDir, 'accept.log') };
const logger = createLogger(config.logFile, runId);
const store = new SecretStore(config.dbPath);
const service = new SecretService(store, config, logger);
const app = buildServer(service, logger);

let base = '';
let failures = 0;
let stepNo = 0;

interface Check { label: string; ok: boolean; detail: string }

async function step(title: string, method: string, url: string, body: unknown, checks: (status: number, json: any, raw: string) => Check[]): Promise<void> {
  stepNo += 1;
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { /* non-JSON */ }
  const results = checks(res.status, json, raw);
  const ok = results.every((c) => c.ok);
  if (!ok) failures += 1;
  console.log(`\n[step ${stepNo}] ${ok ? 'PASS' : 'FAIL'} 閳?${title}`);
  console.log(`  request : ${method} ${url}${body === undefined ? '' : ' body=' + JSON.stringify(body)}`);
  console.log(`  response: ${res.status} ${raw.length > 300 ? raw.slice(0, 300) + '...' : raw}`);
  for (const c of results) {
    console.log(`  ${c.ok ? '[ok]' : '[BAD]'} ${c.label}: ${c.detail}`);
  }
}

const expect = (label: string, actual: unknown, wanted: unknown): Check => ({
  label,
  ok: JSON.stringify(actual) === JSON.stringify(wanted),
  detail: `expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`,
});

async function main() {
  const addr = await app.listen({ host: '127.0.0.1', port: 0 });
  base = addr;
  console.log(`acceptance run id: ${runId}`);
  console.log(`server: ${addr}  db: ${config.dbPath}  log: ${config.logFile}`);

  // Scenario 1: three-level scope override resolution.
  await step('declare API_TOKEN at org scope', 'PUT', '/orgs/acme/secrets/API_TOKEN', { value: 'org-token-v1' },
    (s, j) => [expect('status', s, 200), expect('version', j?.version, 1)]);
  await step('declare API_TOKEN at project scope', 'PUT', '/orgs/acme/projects/web/secrets/API_TOKEN', { value: 'proj-token-v1' },
    (s, j) => [expect('status', s, 200), expect('version', j?.version, 1)]);
  await step('declare API_TOKEN at env scope', 'PUT', '/orgs/acme/projects/web/environments/prod/secrets/API_TOKEN', { value: 'env-token-v1' },
    (s, j) => [expect('status', s, 200), expect('version', j?.version, 1)]);
  await step('declare ORG_ONLY at org scope', 'PUT', '/orgs/acme/secrets/ORG_ONLY', { value: 'org-only-secret' },
    (s, j) => [expect('status', s, 200)]);
  await step('declare PROJ_ONLY at project scope', 'PUT', '/orgs/acme/projects/web/secrets/PROJ_ONLY', { value: 'proj-only-secret' },
    (s, j) => [expect('status', s, 200)]);

  await step('scenario 1: create env prod - nearest scope wins per key', 'POST', '/orgs/acme/projects/web/environments',
    { env: 'prod', required: ['API_TOKEN', 'ORG_ONLY', 'PROJ_ONLY'] },
    (s, j) => {
      const byName = new Map<string, any>((j?.secrets ?? []).map((x: any) => [x.name, x]));
      return [
        expect('status', s, 201),
        expect('API_TOKEN level', byName.get('API_TOKEN')?.level, 'env'),
        expect('API_TOKEN fingerprint', byName.get('API_TOKEN')?.fingerprint, 'b8f5e926903f'),
        expect('API_TOKEN sourcePath', byName.get('API_TOKEN')?.sourcePath, 'org:acme/project:web/env:prod'),
        expect('ORG_ONLY level', byName.get('ORG_ONLY')?.level, 'org'),
        expect('ORG_ONLY fingerprint', byName.get('ORG_ONLY')?.fingerprint, '3ab01d8ae5a7'),
        expect('PROJ_ONLY level', byName.get('PROJ_ONLY')?.level, 'project'),
        expect('PROJ_ONLY fingerprint', byName.get('PROJ_ONLY')?.fingerprint, '44af71be0e39'),
      ];
    });

  // Scenario 2: snapshot isolation - update declarations, old env unchanged.
  await step('update project API_TOKEN to v2 after env creation', 'PUT', '/orgs/acme/projects/web/secrets/API_TOKEN', { value: 'proj-token-v2' },
    (s, j) => [expect('status', s, 200), expect('version', j?.version, 2)]);
  await step('scenario 2: old env keeps creation-time snapshot', 'GET', '/orgs/acme/projects/web/environments/prod/secrets', undefined,
    (s, j) => {
      const token = (j?.secrets ?? []).find((x: any) => x.name === 'API_TOKEN');
      return [
        expect('status', s, 200),
        expect('level still env', token?.level, 'env'),
        expect('fingerprint unchanged', token?.fingerprint, 'b8f5e926903f'),
        expect('declarationVersion pinned', token?.declarationVersion, 1),
      ];
    });
  await step('scenario 2b: new env staging sees updated project value', 'POST', '/orgs/acme/projects/web/environments',
    { env: 'staging', required: ['API_TOKEN'] },
    (s, j) => {
      const token = (j?.secrets ?? []).find((x: any) => x.name === 'API_TOKEN');
      return [
        expect('status', s, 201),
        expect('level now project', token?.level, 'project'),
        expect('fingerprint is v2', token?.fingerprint, '9a03aa525b99'),
        expect('declarationVersion', token?.declarationVersion, 2),
      ];
    });

  // Scenario 3: redacted query - no plaintext anywhere in the response.
  await step('scenario 3: secrets query is redacted (name/level/fingerprint only)', 'GET', '/orgs/acme/projects/web/environments/prod/secrets', undefined,
    (s, j, raw) => [
      expect('status', s, 200),
      { label: 'no plaintext env-token-v1', ok: !raw.includes('env-token-v1'), detail: raw.includes('env-token-v1') ? 'LEAKED' : 'absent' },
      { label: 'no plaintext org-only-secret', ok: !raw.includes('org-only-secret'), detail: raw.includes('org-only-secret') ? 'LEAKED' : 'absent' },
      { label: 'no plaintext proj-only-secret', ok: !raw.includes('proj-only-secret'), detail: raw.includes('proj-only-secret') ? 'LEAKED' : 'absent' },
      { label: 'fields limited to redacted view', ok: (j?.secrets ?? []).every((x: any) => !('value' in x)), detail: 'no value field present' },
    ]);

  // Scenario 4: deleting a referenced declaration is rejected with 409 + referencers.
  await step('scenario 4: delete referenced env-scope declaration -> 409', 'DELETE', '/orgs/acme/projects/web/environments/prod/secrets/API_TOKEN', undefined,
    (s, j) => [
      expect('status', s, 409),
      expect('category', j?.error?.category, 'STATE_CONFLICT'),
      expect('code', j?.error?.code, 'DECLARATION_IN_USE'),
      { label: 'referencers listed', ok: Array.isArray(j?.error?.details?.referencedBy) && j.error.details.referencedBy.length === 1, detail: JSON.stringify(j?.error?.details?.referencedBy) },
    ]);

  // Scenario 5: undeclared secret names are rejected and named.
  await step('scenario 5: create env with undeclared names -> 400 with missing list', 'POST', '/orgs/acme/projects/web/environments',
    { env: 'qa', required: ['API_TOKEN', 'GHOST_A', 'GHOST_B'] },
    (s, j) => [
      expect('status', s, 400),
      expect('category', j?.error?.category, 'INPUT_ERROR'),
      expect('code', j?.error?.code, 'UNDECLARED_SECRETS'),
      expect('missing', j?.error?.details?.missing, ['GHOST_A', 'GHOST_B']),
    ]);

  // Scenario 6: cascade delete of environment unblocks declaration delete.
  await step('scenario 6: delete env prod cascades snapshots', 'DELETE', '/orgs/acme/projects/web/environments/prod', undefined,
    (s, j) => [expect('status', s, 200), expect('removedSnapshots', j?.removedSnapshots, 3)]);
  await step('scenario 6b: declaration delete now succeeds', 'DELETE', '/orgs/acme/projects/web/environments/prod/secrets/API_TOKEN', undefined,
    (s, j) => [expect('status', s, 200)]);
  await step('scenario 6c: deleted env is gone', 'GET', '/orgs/acme/projects/web/environments/prod/secrets', undefined,
    (s, j) => [expect('status', s, 404), expect('category', j?.error?.category, 'NOT_FOUND')]);

  // Scenario 7: bindings query by environment and by name.
  await step('scenario 7: bindings query by secret name', 'GET', '/bindings?name=API_TOKEN', undefined,
    (s, j) => [
      expect('status', s, 200),
      { label: 'staging binding present', ok: (j?.bindings ?? []).some((b: any) => b.environment.env === 'staging' && b.environment.status === 'active'), detail: JSON.stringify((j?.bindings ?? []).map((b: any) => b.environment.env)) },
      { label: 'no plaintext in bindings', ok: !JSON.stringify(j).includes('proj-token-v2'), detail: 'absent' },
    ]);

  console.log('\n========================================');
  console.log(`acceptance run ${runId}: ${failures === 0 ? 'ALL SCENARIOS PASSED' : failures + ' step(s) FAILED'}`);
  console.log(`evidence log: ${config.logFile}`);

  await app.close();
  store.close();
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('acceptance run ' + runId + ' crashed:', err);
  process.exit(2);
});


