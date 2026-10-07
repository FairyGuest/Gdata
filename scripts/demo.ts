// Local demo: boots the service on a scratch sqlite file and walks through
// the main flows with plain fetch calls. Safe to run repeatedly.
import { buildServer } from '../src/server.ts';

const PORT = 3210;
const BASE = 'http://127.0.0.1:' + PORT;

async function show(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  console.log(method + ' ' + path + ' -> ' + res.status);
  console.log(JSON.stringify(json, null, 2));
}

const { app } = buildServer({ host: '127.0.0.1', port: PORT, dbPath: ':memory:' });
await app.listen({ host: '127.0.0.1', port: PORT });

await show('POST', '/nodes', { name: 'node-a', cpu: 4, memMb: 8192 });
await show('POST', '/nodes', { name: 'node-b', cpu: 8, memMb: 16384 });
await show('POST', '/namespaces', { name: 'demo', quotaCpu: 6, quotaMemMb: 12288 });
await show('POST', '/workloads', { id: 'job-1', namespace: 'demo', cpu: 4, memMb: 8192 });
await show('POST', '/workloads', { id: 'job-2', namespace: 'demo', cpu: 4, memMb: 4096 }); // quota exceeded
await show('POST', '/workloads', { id: 'job-3', namespace: 'demo', cpu: 2, memMb: 4096 }); // placed on node-b
await show('GET', '/diag/state');
await show('DELETE', '/workloads/job-1');
await show('GET', '/diag/conservation');
await show('DELETE', '/namespaces/demo');
await show('GET', '/diag/history?namespace=demo');

await app.close();

