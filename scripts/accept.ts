// One-shot acceptance drill. Boots the real HTTP service on an ephemeral
// port with a throwaway SQLite file, then walks every lifecycle scenario in
// a fixed order, printing request, response and verdict per step.
// Exit 0 when every step passes, 1 otherwise (failing scenario is named).

import { startService } from '../src/server.ts';
import { rmSync } from 'node:fs';

const DB_FILE = 'data/accept.db';
rmSync(DB_FILE, { force: true });

let failures = 0;
let step = 0;
const service = await startService({ dbFile: DB_FILE, port: 0 });
const base = `http://127.0.0.1:${service.port}`;
console.log(`# acceptance run ${service.runId} (adapter=${service.adapter}, base=${base})`);

interface Check { label: string; pass: boolean; detail: string }

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function scenario(title: string, fn: () => Promise<Check[]>) {
  step += 1;
  console.log(`\n== scenario ${step}: ${title}`);
  try {
    const checks = await fn();
    for (const c of checks) {
      console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.label} -- ${c.detail}`);
      if (!c.pass) failures += 1;
    }
  } catch (err) {
    failures += 1;
    console.log(`  [FAIL] scenario threw: ${err instanceof Error ? err.message : err}`);
  }
}

const show = (r: { status: number; json: unknown }) => `status=${r.status} body=${JSON.stringify(r.json)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let envA = '';
let envB = '';

await scenario('idempotent create vs param conflict', async () => {
  const create1 = await call('POST', '/environments', { owner: 'alice', branch: 'feat/login', overrides: { 'web.replicas': 2 }, ttlSeconds: 30 });
  console.log('  > POST /environments ' + show(create1));
  envA = create1.json.id;
  const create2 = await call('POST', '/environments', { owner: 'alice', branch: 'feat/login', overrides: { 'web.replicas': 2 }, ttlSeconds: 30 });
  console.log('  > POST /environments (replay) ' + show(create2));
  const conflict = await call('POST', '/environments', { owner: 'alice', branch: 'feat/login', overrides: { 'web.replicas': 9 } });
  console.log('  > POST /environments (different params) ' + show(conflict));
  return [
    { label: 'create returns 201 with env id', pass: create1.status === 201 && typeof envA === 'string' && envA.startsWith('env-'), detail: show(create1) },
    { label: 'replay is idempotent: 200, same id', pass: create2.status === 200 && create2.json.idempotent === true && create2.json.id === envA, detail: show(create2) },
    { label: 'different params -> 409 BRANCH_PARAM_CONFLICT with existing id', pass: conflict.status === 409 && conflict.json.error?.code === 'BRANCH_PARAM_CONFLICT' && conflict.json.error?.details?.existingEnvId === envA, detail: show(conflict) },
  ];
});

await scenario('parameter validation rejects unknown and mistyped params', async () => {
  const unknown = await call('POST', '/environments', { owner: 'alice', branch: 'feat/x', overrides: { 'db.host': 'db' } });
  console.log('  > POST /environments (unknown param) ' + show(unknown));
  const mistyped = await call('POST', '/environments', { owner: 'alice', branch: 'feat/x', overrides: { 'web.replicas': 'two' } });
  console.log('  > POST /environments (type mismatch) ' + show(mistyped));
  return [
    { label: 'unknown param -> 400 UNKNOWN_PARAM naming db.host', pass: unknown.status === 400 && unknown.json.error?.code === 'UNKNOWN_PARAM' && unknown.json.error?.details?.param === 'db.host', detail: show(unknown) },
    { label: 'type mismatch -> 400 PARAM_TYPE_MISMATCH naming web.replicas', pass: mistyped.status === 400 && mistyped.json.error?.code === 'PARAM_TYPE_MISMATCH' && mistyped.json.error?.details?.param === 'web.replicas' && mistyped.json.error?.details?.expected === 'number', detail: show(mistyped) },
  ];
});

await scenario('delete lock while DEPLOYING and audited force delete', async () => {
  const plain = await call('DELETE', `/environments/${envA}`);
  console.log(`  > DELETE /environments/${envA} ` + show(plain));
  const forceNoReason = await call('DELETE', `/environments/${envA}?force=true`);
  console.log('  > DELETE ?force=true (no reason) ' + show(forceNoReason));
  const forced = await call('DELETE', `/environments/${envA}?force=true&reason=deploy+stuck`);
  console.log('  > DELETE ?force=true&reason=... ' + show(forced));
  const audit = await call('GET', `/diagnostics/audit?envId=${envA}&action=delete`);
  console.log(`  > GET /diagnostics/audit?envId=${envA}&action=delete ` + show(audit));
  const allowEntries = (audit.json.audit ?? []).filter((e: any) => e.outcome === 'ALLOW');
  return [
    { label: 'plain delete -> 409 DELETE_LOCKED', pass: plain.status === 409 && plain.json.error?.code === 'DELETE_LOCKED', detail: show(plain) },
    { label: 'force without reason -> 400 FORCE_REASON_REQUIRED', pass: forceNoReason.status === 400 && forceNoReason.json.error?.code === 'FORCE_REASON_REQUIRED', detail: show(forceNoReason) },
    { label: 'force with reason -> 200, status DELETED', pass: forced.status === 200 && forced.json.env?.status === 'DELETED', detail: show(forced) },
    { label: 'audit records force reason', pass: allowEntries.length === 1 && allowEntries[0].details?.forceReason === 'deploy stuck', detail: JSON.stringify(allowEntries) },
  ];
});

await scenario('quota pool: limit enforced and current usage reported', async () => {
  const b = await call('POST', '/environments', { owner: 'bob', branch: 'feat/b1', ttlSeconds: 30 });
  const c = await call('POST', '/environments', { owner: 'bob', branch: 'feat/b2', ttlSeconds: 30 });
  envB = b.json.id;
  const over = await call('POST', '/environments', { owner: 'bob', branch: 'feat/b3' });
  console.log('  > POST /environments x3 for bob; third: ' + show(over));
  return [
    { label: 'first two creations succeed', pass: b.status === 201 && c.status === 201, detail: `${b.status},${c.status}` },
    { label: 'third -> 409 QUOTA_EXCEEDED with used=2 max=2', pass: over.status === 409 && over.json.error?.code === 'QUOTA_EXCEEDED' && over.json.error?.details?.used === 2 && over.json.error?.details?.max === 2, detail: show(over) },
  ];
});

await scenario('renew once, then expiry sweep reclaims and releases quota', async () => {
  const renewed = await call('POST', `/environments/${envB}/renew`);
  console.log(`  > POST /environments/${envB}/renew ` + show(renewed));
  const renewAgain = await call('POST', `/environments/${envB}/renew`);
  console.log('  > renew again ' + show(renewAgain));
  console.log('  > waiting 1.2s for 1s-TTL env to expire...');
  const short = await call('POST', '/environments', { owner: 'carol', branch: 'feat/short', ttlSeconds: 1 });
  await sleep(1200);
  const sweep = await call('POST', '/admin/sweep');
  console.log('  > POST /admin/sweep ' + show(sweep));
  const shortEnv = await call('GET', `/environments/${short.json.id}`);
  const after = await call('POST', '/environments', { owner: 'carol', branch: 'feat/short-2', ttlSeconds: 30 });
  console.log('  > create after reclaim ' + show(after));
  return [
    { label: 'renew -> 200, renewalsUsed=1', pass: renewed.status === 200 && renewed.json.env?.renewalsUsed === 1, detail: show(renewed) },
    { label: 'second renew -> 409 INVALID_STATE', pass: renewAgain.status === 409 && renewAgain.json.error?.code === 'INVALID_STATE', detail: show(renewAgain) },
    { label: 'sweep reclaimed the expired env', pass: sweep.status === 200 && Array.isArray(sweep.json.reclaimed) && sweep.json.reclaimed.includes(short.json.id), detail: show(sweep) },
    { label: 'expired env status is RECLAIMED', pass: shortEnv.json.env?.status === 'RECLAIMED', detail: show(shortEnv) },
    { label: 'quota released: carol can create again', pass: after.status === 201, detail: show(after) },
  ];
});

await scenario('diagnostics: query by branch and status', async () => {
  const byBranch = await call('GET', '/diagnostics/environments?branch=feat/login');
  const byStatus = await call('GET', '/diagnostics/environments?status=RECLAIMED');
  console.log('  > GET /diagnostics/environments?branch=feat/login ' + show(byBranch));
  console.log('  > GET /diagnostics/environments?status=RECLAIMED count=' + byStatus.json.environments?.length);
  return [
    { label: 'branch query returns the deleted feat/login env', pass: byBranch.status === 200 && byBranch.json.environments?.some((e: any) => e.id === envA && e.status === 'DELETED'), detail: show(byBranch) },
    { label: 'status query returns reclaimed envs', pass: byStatus.status === 200 && byStatus.json.environments?.every((e: any) => e.status === 'RECLAIMED') && byStatus.json.environments.length >= 1, detail: `count=${byStatus.json.environments?.length}` },
  ];
});

await service.close();
console.log(`` + `\n# result: ${failures === 0 ? 'ALL SCENARIOS PASSED' : failures + ' check(s) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);

