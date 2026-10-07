// API integration tests over Fastify inject: HTTP status codes must match
// the error taxonomy, and history must be queryable per namespace / node.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.ts';
import type { App } from '../src/server.ts';

let ctx: App;

before(async () => { ctx = buildServer({ host: '127.0.0.1', port: 0, dbPath: ':memory:' }); });
after(async () => { await ctx.app.close(); });

test('full lifecycle over HTTP', async () => {
  const inj = ctx.app.inject.bind(ctx.app);

  let r = await inj({ method: 'POST', url: '/nodes', payload: { name: 'n1', cpu: 4, memMb: 8192 } });
  assert.equal(r.statusCode, 201);
  r = await inj({ method: 'POST', url: '/namespaces', payload: { name: 'ns1', quotaCpu: 4, quotaMemMb: 8192 } });
  assert.equal(r.statusCode, 201);

  // duplicate namespace -> 409 CONFLICT
  r = await inj({ method: 'POST', url: '/namespaces', payload: { name: 'ns1', quotaCpu: 1, memMb: 1, quotaMemMb: 1 } });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error.kind, 'CONFLICT');

  // placement into missing namespace -> 404 NOT_FOUND
  r = await inj({ method: 'POST', url: '/workloads', payload: { namespace: 'nope', cpu: 1, memMb: 1 } });
  assert.equal(r.statusCode, 404);
  assert.equal(r.json().error.kind, 'NOT_FOUND');

  // invalid payload -> 400 VALIDATION
  r = await inj({ method: 'POST', url: '/workloads', payload: { namespace: 'ns1', cpu: -3, memMb: 1 } });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error.kind, 'VALIDATION');

  // place and fill quota
  r = await inj({ method: 'POST', url: '/workloads', payload: { id: 'w1', namespace: 'ns1', cpu: 4, memMb: 8192 } });
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().data.outcome, 'placed');
  assert.equal(r.json().data.nodeId, 'node-1');

  // quota full -> 422 QUOTA_EXCEEDED with deficit
  r = await inj({ method: 'POST', url: '/workloads', payload: { id: 'w2', namespace: 'ns1', cpu: 1, memMb: 1 } });
  assert.equal(r.statusCode, 422);
  const body = r.json();
  assert.equal(body.error.kind, 'QUOTA_EXCEEDED');
  assert.deepEqual(body.error.details.deficit, { cpu: 1, memMb: 1 });

  // conservation holds
  r = await inj({ method: 'GET', url: '/diag/conservation' });
  assert.equal(r.json().balanced, true);
  assert.deepEqual(r.json().allocations, { cpu: 4, memMb: 8192 });

  // delete workload -> both books released
  r = await inj({ method: 'DELETE', url: '/workloads/w1' });
  assert.equal(r.statusCode, 200);
  r = await inj({ method: 'GET', url: '/diag/state' });
  assert.deepEqual(r.json().nodes[0].used, { cpu: 0, memMb: 0 });
  assert.deepEqual(r.json().namespaces[0].used, { cpu: 0, memMb: 0 });

  // history queryable by namespace and node
  r = await inj({ method: 'GET', url: '/diag/history?namespace=ns1' });
  const events = r.json().map((h: { event: string }) => h.event);
  assert.deepEqual(events, ['placed', 'released']);
  r = await inj({ method: 'GET', url: '/diag/history?node=node-1' });
  assert.equal(r.json().length, 2);
});

test('namespace delete over HTTP cascades and evicts traceably', async () => {
  const inj = ctx.app.inject.bind(ctx.app);
  await inj({ method: 'POST', url: '/namespaces', payload: { name: 'ns2', quotaCpu: 4, quotaMemMb: 8192 } });
  await inj({ method: 'POST', url: '/workloads', payload: { id: 'x1', namespace: 'ns2', cpu: 2, memMb: 1024 } });
  const r = await inj({ method: 'DELETE', url: '/namespaces/ns2' });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.data.evicted.length, 1);
  assert.equal(body.data.evicted[0].workloadId, 'x1');
  const h = await inj({ method: 'GET', url: '/diag/history?namespace=ns2' });
  assert.ok(h.json().some((e: { event: string }) => e.event === 'evicted'));
});

