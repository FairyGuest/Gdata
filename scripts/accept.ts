// One-shot acceptance script: exercises every required scenario in a fixed
// order against a real HTTP server (in-process, ephemeral port, in-memory DB).
// Prints request / response / verdict per step. Exit 0 = all pass, 1 = failure.
import { createHandler } from '../src/http/core.ts';
import { startNodeServer } from '../src/http/node-server.ts';
import { DatasetStore } from '../src/state/store.ts';
import { loadConfig } from '../src/config.ts';
import type { AddressInfo } from 'node:net';

const config = loadConfig();
const store = new DatasetStore(':memory:');
const handle = createHandler(store, config);
const server = await startNodeServer(handle, 0);
const port = (server.address() as AddressInfo).port;
const base = 'http://127.0.0.1:' + port;

let failures = 0;

interface StepResult {
  ok: boolean;
  detail: string;
}

async function step(name: string, fn: () => Promise<StepResult>): Promise<void> {
  try {
    const r = await fn();
    console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + name + '  ->  ' + r.detail);
    if (!r.ok) failures++;
  } catch (e) {
    console.log('FAIL  ' + name + '  ->  threw: ' + (e instanceof Error ? e.message : String(e)));
    failures++;
  }
}

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  console.log('     ' + method + ' ' + path + (body !== undefined ? '  body=' + JSON.stringify(body).slice(0, 120) : ''));
  console.log('     <- ' + res.status + ' ' + JSON.stringify(json).slice(0, 160));
  return { status: res.status, json };
}

const demoSchema = {
  fields: {
    id: { kind: 'integer', min: 1, max: 100 },
    name: { kind: 'string', minLength: 5, maxLength: 5 },
    role: { kind: 'enum', values: ['admin', 'user', 'guest'] },
    birthday: { kind: 'date', min: '1990-01-01', max: '2000-12-31' },
  },
};

console.log('=== test-data-factory acceptance run ===');
console.log('server: ' + base + '  db: :memory:  limits: ' + JSON.stringify(config.limits));

await step('S1 health check', async () => {
  const r = await req('GET', '/health');
  return { ok: r.status === 200 && r.json.status === 'ok', detail: 'status=' + r.status };
});

await step('S2 schema validation accepts a valid schema', async () => {
  const r = await req('POST', '/schemas/validate', { schema: demoSchema });
  return { ok: r.status === 200 && r.json.valid === true, detail: 'valid=' + String(r.json.valid) };
});

let runId = '';
await step('S3 same seed twice yields byte-identical rows', async () => {
  const a = await req('POST', '/generate', { schema: demoSchema, seed: 42, count: 20 });
  const b = await req('POST', '/generate', { schema: demoSchema, seed: 42, count: 20 });
  runId = String(a.json.runId ?? '');
  const same = JSON.stringify(a.json.rows) === JSON.stringify(b.json.rows);
  return { ok: a.status === 200 && same, detail: 'identical=' + same + ' runId=' + runId };
});

await step('S4 per-type constraints hold across 200 generated rows', async () => {
  const r = await req('POST', '/generate', { schema: demoSchema, seed: 7, count: 200 });
  const rows = r.json.rows as Record<string, unknown>[];
  const bad = rows.filter((row) => {
    const id = row.id as number;
    const name = row.name as string;
    const role = row.role as string;
    const bd = row.birthday as string;
    return !(Number.isInteger(id) && id >= 1 && id <= 100)
      || !(name.length === 5)
      || !['admin', 'user', 'guest'].includes(role)
      || !(bd >= '1990-01-01' && bd <= '2000-12-31');
  });
  return { ok: r.status === 200 && rows.length === 200 && bad.length === 0, detail: 'rows=' + rows.length + ' violations=' + bad.length };
});

await step('S5 nested object/array generation is recursive and bounded', async () => {
  const nested = {
    fields: {
      user: {
        kind: 'object',
        properties: {
          id: { kind: 'integer', min: 1, max: 1000 },
          tags: { kind: 'array', minItems: 1, maxItems: 3, items: { kind: 'string', minLength: 2, maxLength: 4 } },
        },
      },
    },
  };
  const r = await req('POST', '/generate', { schema: nested, seed: 2026, count: 50 });
  const rows = r.json.rows as { user: { id: number; tags: string[] } }[];
  const bad = rows.filter((row) => !row.user || !Array.isArray(row.user.tags)
    || row.user.tags.length < 1 || row.user.tags.length > 3
    || row.user.tags.some((t) => t.length < 2 || t.length > 4));
  return { ok: r.status === 200 && bad.length === 0, detail: 'rows=' + rows.length + ' violations=' + bad.length };
});

await step('S6 constraint conflict (min > max) returns INPUT_ERROR 400', async () => {
  const r = await req('POST', '/generate', { schema: { fields: { n: { kind: 'integer', min: 10, max: 1 } } }, seed: 1, count: 1 });
  const err = r.json.error as { category?: string } | undefined;
  return { ok: r.status === 400 && err?.category === 'INPUT_ERROR', detail: 'status=' + r.status + ' category=' + String(err?.category) };
});

await step('S7 dataset save then duplicate save returns STATE_CONFLICT 409', async () => {
  const first = await req('POST', '/datasets', { name: 'accept-users', schema: demoSchema, seed: 42, count: 10 });
  const dup = await req('POST', '/datasets', { name: 'accept-users', schema: demoSchema, seed: 42, count: 10 });
  const err = dup.json.error as { category?: string } | undefined;
  return {
    ok: first.status === 201 && dup.status === 409 && err?.category === 'STATE_CONFLICT',
    detail: 'first=' + first.status + ' duplicate=' + dup.status + ' category=' + String(err?.category),
  };
});

await step('S8 saved dataset regenerates identically from stored seed', async () => {
  const r = await req('POST', '/datasets/accept-users/verify');
  return { ok: r.status === 200 && r.json.consistent === true, detail: 'consistent=' + String(r.json.consistent) };
});

await step('S9 count above maxCount returns RESOURCE_EXHAUSTED 413', async () => {
  const r = await req('POST', '/generate', { schema: demoSchema, seed: 1, count: config.limits.maxCount + 1 });
  const err = r.json.error as { category?: string } | undefined;
  return { ok: r.status === 413 && err?.category === 'RESOURCE_EXHAUSTED', detail: 'status=' + r.status + ' category=' + String(err?.category) };
});

await step('S10 unsatisfiable pattern returns COMPUTE_FAILURE 500', async () => {
  const schema = { fields: { s: { kind: 'string', minLength: 1, maxLength: 2, charset: 'ab', pattern: '^z{5}$' } } };
  const r = await req('POST', '/generate', { schema, seed: 1, count: 1 });
  const err = r.json.error as { category?: string } | undefined;
  return { ok: r.status === 500 && err?.category === 'COMPUTE_FAILURE', detail: 'status=' + r.status + ' category=' + String(err?.category) };
});

await step('S11 run log is persisted and replayable via /runs/:runId', async () => {
  const r = await req('GET', '/runs/' + runId);
  const entries = (r.json.entries as unknown[]) ?? [];
  return { ok: r.status === 200 && r.json.runId === runId && entries.length > 0, detail: 'runId=' + runId + ' entries=' + entries.length };
});

await step('S12 missing dataset returns 404 STATE_CONFLICT, not success', async () => {
  const r = await req('GET', '/datasets/does-not-exist');
  const err = r.json.error as { category?: string } | undefined;
  return { ok: r.status === 404 && err?.category === 'STATE_CONFLICT', detail: 'status=' + r.status + ' category=' + String(err?.category) };
});

await new Promise<void>((resolve) => server.close(() => resolve()));
store.close();

console.log('=== acceptance: ' + (failures === 0 ? 'ALL 12 SCENARIOS PASSED' : failures + ' SCENARIO(S) FAILED') + ' ===');
process.exitCode = failures === 0 ? 0 : 1;
