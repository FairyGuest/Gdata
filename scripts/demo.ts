// Local demo: boots the service in-memory and exercises the main flow,
// printing each request/response. Safe to re-run.

import { EnvironmentStore } from '../src/store/sqliteStore.ts';
import { LifecycleKernel } from '../src/core/lifecycle.ts';
import { VirtualClock } from '../src/clock.ts';
import { RunLogger, ConsoleSink } from '../src/logger.ts';
import { parseTemplate } from '../src/contract/template.ts';
import { buildApp } from '../src/server.ts';
import { readFileSync } from 'node:fs';

const template = parseTemplate(JSON.parse(readFileSync('fixtures/template.json', 'utf8')));
const store = new EnvironmentStore(':memory:');
const clock = new VirtualClock();
const kernel = new LifecycleKernel(store, template, clock, { quotaPerOwner: 2, deploySeconds: 30 }, new RunLogger(new ConsoleSink()));
const app = buildApp(kernel, store, clock);
await app.listen(0);
const base = `http://127.0.0.1:${app.port()}`;

async function call(method: string, path: string, body?: unknown): Promise<void> {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  console.log(`${method} ${path} -> ${res.status}`, JSON.stringify(await res.json()));
}

console.log('demo: create, idempotent create, conflict, tick, renew, expire');
await call('POST', '/environments', { branch: 'feat/demo', owner: 'alice', overrides: { replicas: 2 }, ttlSeconds: 120 });
await call('POST', '/environments', { branch: 'feat/demo', owner: 'alice', overrides: { replicas: 2 }, ttlSeconds: 120 });
await call('POST', '/environments', { branch: 'feat/demo', owner: 'alice', overrides: { replicas: 3 }, ttlSeconds: 120 });
await call('POST', '/admin/tick', { advanceSeconds: 30 });
const list = await (await fetch(base + '/environments?branch=feat/demo')).json() as { environments: { id: string }[] };
const id = list.environments[0].id;
await call('POST', `/environments/${id}/renew`);
await call('POST', '/admin/tick', { advanceSeconds: 240 });
await call('GET', `/environments/${id}/transitions`);
await app.close();
store.close();
