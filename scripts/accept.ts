// One-shot acceptance: boots the service on an ephemeral port with a
// VirtualClock, then drills every lifecycle scenario in a fixed order,
// printing request / response / verdict per step.
// Exit 0 when every check passes, 1 with the failing scenario otherwise.

import { EnvironmentStore } from '../src/store/sqliteStore.ts';
import { LifecycleKernel } from '../src/core/lifecycle.ts';
import { VirtualClock } from '../src/clock.ts';
import { RunLogger, MemorySink } from '../src/logger.ts';
import { parseTemplate } from '../src/contract/template.ts';
import { buildApp } from '../src/server.ts';
import { readFileSync } from 'node:fs';

const template = parseTemplate(JSON.parse(readFileSync('fixtures/template.json', 'utf8')));
const store = new EnvironmentStore(':memory:');
const clock = new VirtualClock(1_760_000_000_000);
const sink = new MemorySink();
const kernel = new LifecycleKernel(store, template, clock, { quotaPerOwner: 2, deploySeconds: 30 }, new RunLogger(sink));
const app = buildApp(kernel, store, clock);
await app.listen(0);
const base = `http://127.0.0.1:${app.port()}`;

let failures = 0;
let step = 0;

interface Check { desc: string; ok: boolean; detail?: string }

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() as Record<string, any> };
}

async function scenario(name: string, fn: () => Promise<Check[]>): Promise<void> {
  console.log(`\n=== ${name} ===`);
  const checks = await fn();
  for (const c of checks) {
    step += 1;
    console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] step ${step}: ${c.desc}`);
    console.log(`        ${c.detail ?? ''}`);
    if (!c.ok) failures += 1;
  }
}

function show(method: string, path: string, body: unknown, status: number, json: unknown): string {
  const reqStr = body !== undefined ? ` ${JSON.stringify(body)}` : '';
  return `${method} ${path}${reqStr} -> ${status} ${JSON.stringify(json)}`;
}

// --- S1: idempotent create vs param conflict ---
let envA = '';
await scenario('S1 idempotent create / param conflict', async () => {
  const checks: Check[] = [];
  const body = { branch: 'feat/login', owner: 'alice', overrides: { replicas: 2 }, ttlSeconds: 300 };
  const c1 = await req('POST', '/environments', body);
  checks.push({ desc: 'first create returns 201 with env id', ok: c1.status === 201 && typeof c1.json.env?.id === 'string', detail: show('POST', '/environments', body, c1.status, c1.json) });
  envA = c1.json.env.id;
  const c2 = await req('POST', '/environments', body);
  checks.push({ desc: 'same branch+params is idempotent: 200, same id', ok: c2.status === 200 && c2.json.idempotent === true && c2.json.env.id === envA, detail: show('POST', '/environments', body, c2.status, c2.json) });
  const c3 = await req('POST', '/environments', { ...body, overrides: { replicas: 9 } });
  checks.push({ desc: 'same branch different params -> 409 BRANCH_ENV_EXISTS with existing id', ok: c3.status === 409 && c3.json.error?.code === 'BRANCH_ENV_EXISTS' && c3.json.error?.details?.existingEnvId === envA, detail: show('POST', '/environments', { ...body, overrides: { replicas: 9 } }, c3.status, c3.json) });
  return checks;
});

// --- S2: parameter validation ---
await scenario('S2 parameter validation', async () => {
  const checks: Check[] = [];
  const b1 = { branch: 'feat/bad1', owner: 'alice', overrides: { nope: 1 } };
  const u1 = await req('POST', '/environments', b1);
  checks.push({ desc: 'unknown param -> 400 naming the key', ok: u1.status === 400 && u1.json.error?.category === 'validation' && JSON.stringify(u1.json).includes('nope'), detail: show('POST', '/environments', b1, u1.status, u1.json) });
  const b2 = { branch: 'feat/bad2', owner: 'alice', overrides: { replicas: 'many' } };
  const u2 = await req('POST', '/environments', b2);
  checks.push({ desc: 'type mismatch -> 400 naming key and types', ok: u2.status === 400 && u2.json.error?.category === 'validation' && JSON.stringify(u2.json).includes('replicas'), detail: show('POST', '/environments', b2, u2.status, u2.json) });
  return checks;
});

// --- S3: expiry reclaim + renew ---
await scenario('S3 expiry reclaim and one-time renew', async () => {
  const checks: Check[] = [];
  const t1 = await req('POST', '/admin/tick', { advanceSeconds: 30 });
  checks.push({ desc: 'deploy finishes after deploySeconds', ok: t1.status === 200 && t1.json.deployed?.includes(envA), detail: show('POST', '/admin/tick', { advanceSeconds: 30 }, t1.status, t1.json) });
  const r1 = await req('POST', `/environments/${envA}/renew`);
  checks.push({ desc: 'renew active env succeeds, extends expiry', ok: r1.status === 200 && r1.json.env.renewed === true, detail: show('POST', `/environments/${envA}/renew`, undefined, r1.status, r1.json) });
  const r2 = await req('POST', `/environments/${envA}/renew`);
  checks.push({ desc: 'second renew -> 409 ALREADY_RENEWED', ok: r2.status === 409 && r2.json.error?.code === 'ALREADY_RENEWED', detail: show('POST', `/environments/${envA}/renew`, undefined, r2.status, r2.json) });
  const t2 = await req('POST', '/admin/tick', { advanceSeconds: 600 });
  checks.push({ desc: 'after renewed ttl expires env is reclaimed', ok: t2.json.reclaimed?.includes(envA), detail: show('POST', '/admin/tick', { advanceSeconds: 600 }, t2.status, t2.json) });
  const g1 = await req('GET', `/environments/${envA}`);
  checks.push({ desc: 'reclaimed status persisted and queryable', ok: g1.json.env?.status === 'reclaimed', detail: show('GET', `/environments/${envA}`, undefined, g1.status, g1.json) });
  return checks;
});

// --- S4: quota pool ---
await scenario('S4 quota pool', async () => {
  const checks: Check[] = [];
  const q1 = await req('POST', '/environments', { branch: 'b1', owner: 'bob' });
  await req('POST', '/environments', { branch: 'b2', owner: 'bob' });
  const b3 = { branch: 'b3', owner: 'bob' };
  const q3 = await req('POST', '/environments', b3);
  checks.push({ desc: 'third env for same owner -> 429 QUOTA_EXCEEDED listing occupancy', ok: q3.status === 429 && q3.json.error?.code === 'QUOTA_EXCEEDED' && Array.isArray(q3.json.error?.details?.activeEnvIds) && q3.json.error.details.activeEnvIds.length === 2, detail: show('POST', '/environments', b3, q3.status, q3.json) });
  const q4 = await req('POST', '/environments', { branch: 'b3', owner: 'carol' });
  checks.push({ desc: 'other owner unaffected', ok: q4.status === 201, detail: show('POST', '/environments', { branch: 'b3', owner: 'carol' }, q4.status, q4.json) });
  const d1 = await req('DELETE', `/environments/${q1.json.env.id}?force=true&reason=cleanup`);
  checks.push({ desc: 'delete frees a quota slot', ok: d1.status === 200, detail: show('DELETE', `/environments/${q1.json.env.id}?force=true&reason=cleanup`, undefined, d1.status, d1.json) });
  const q5 = await req('POST', '/environments', { branch: 'b4', owner: 'bob' });
  checks.push({ desc: 'create succeeds again after free', ok: q5.status === 201, detail: show('POST', '/environments', { branch: 'b4', owner: 'bob' }, q5.status, q5.json) });
  return checks;
});

// --- S5: delete lock + forced delete audit ---
await scenario('S5 delete lock and forced-delete audit', async () => {
  const checks: Check[] = [];
  const c1 = await req('POST', '/environments', { branch: 'feat/hotfix', owner: 'dave' });
  const id = c1.json.env.id as string;
  const d1 = await req('DELETE', `/environments/${id}`);
  checks.push({ desc: 'delete while deploying -> 409 DEPLOY_IN_PROGRESS', ok: d1.status === 409 && d1.json.error?.code === 'DEPLOY_IN_PROGRESS', detail: show('DELETE', `/environments/${id}`, undefined, d1.status, d1.json) });
  const d2 = await req('DELETE', `/environments/${id}?force=true`, { reason: 'wedged build agent', actor: 'ops-dana' });
  checks.push({ desc: 'forced delete succeeds', ok: d2.status === 200 && d2.json.env.status === 'deleted', detail: show('DELETE', `/environments/${id}?force=true`, { reason: 'wedged build agent', actor: 'ops-dana' }, d2.status, d2.json) });
  const a1 = await req('GET', `/audit?envId=${id}`);
  const forced = (a1.json.audit as Array<Record<string, unknown>>).filter((a) => a.action === 'force_delete');
  checks.push({ desc: 'audit log records force_delete with reason and actor', ok: forced.length === 1 && forced[0].reason === 'wedged build agent' && forced[0].actor === 'ops-dana', detail: show('GET', `/audit?envId=${id}`, undefined, a1.status, a1.json) });
  return checks;
});

// --- S6: query by branch / status ---
await scenario('S6 query by branch and status', async () => {
  const checks: Check[] = [];
  const l1 = await req('GET', '/environments?branch=feat/login');
  checks.push({ desc: 'filter by branch returns the reclaimed env', ok: l1.status === 200 && l1.json.environments.length === 1 && l1.json.environments[0].id === envA, detail: show('GET', '/environments?branch=feat/login', undefined, l1.status, l1.json) });
  const l2 = await req('GET', '/environments?status=reclaimed');
  checks.push({ desc: 'filter by status=reclaimed includes envA', ok: l2.status === 200 && (l2.json.environments as Array<{ id: string }>).some((e) => e.id === envA), detail: show('GET', '/environments?status=reclaimed', undefined, l2.status, { count: l2.json.environments.length }) });
  return checks;
});

await app.close();
store.close();

console.log(`\n${failures === 0 ? 'ACCEPTANCE PASSED' : 'ACCEPTANCE FAILED'}: ${step - failures}/${step} checks passed`);
process.exitCode = failures === 0 ? 0 : 1;
