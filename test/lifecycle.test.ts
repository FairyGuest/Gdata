import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeKernel } from './helpers.ts';
import { BranchConflictError, InvalidStateError, NotFoundError, QuotaExceededError } from '../src/errors.ts';

function capture<T extends Error>(fn: () => unknown): T {
  try { fn(); } catch (e) { return e as T; }
  throw new Error('expected function to throw');
}

test('create: returns globally unique short id, starts in deploying', async () => {
  const { kernel } = makeKernel();
  const a = await kernel.create({ branch: 'feat/a', owner: 'alice' });
  const b = await kernel.create({ branch: 'feat/b', owner: 'alice' });
  assert.match(a.env.id, /^env-[0-9a-f]{8}$/);
  assert.notEqual(a.env.id, b.env.id);
  assert.equal(a.env.status, 'deploying');
  assert.equal(a.idempotent, false);
});

test('idempotent: same branch + same params returns existing env', async () => {
  const { kernel } = makeKernel();
  const first = await kernel.create({ branch: 'feat/x', owner: 'alice', overrides: { replicas: 2 }, ttlSeconds: 600 });
  const second = await kernel.create({ branch: 'feat/x', owner: 'alice', overrides: { replicas: 2 }, ttlSeconds: 600 });
  assert.equal(second.idempotent, true);
  assert.equal(second.env.id, first.env.id);
  assert.equal(kernel.list({ branch: 'feat/x' }).length, 1);
});

test('conflict: same branch + different params -> conflict error with existing env id', async () => {
  const { kernel } = makeKernel();
  const first = await kernel.create({ branch: 'feat/x', owner: 'alice', overrides: { replicas: 2 } });
  const err = await kernel.create({ branch: 'feat/x', owner: 'alice', overrides: { replicas: 5 } })
    .then(() => { throw new Error('expected rejection'); }, (e) => e as BranchConflictError);
  assert.ok(err instanceof BranchConflictError);
  assert.equal(err.category, 'conflict');
  assert.equal(err.code, 'BRANCH_ENV_EXISTS');
  assert.equal(err.details.existingEnvId, first.env.id);
});

test('expiry: active env is reclaimed after ttl and quota is released', async () => {
  const { kernel, clock, store } = makeKernel({ deploySeconds: 10 });
  const { env } = await kernel.create({ branch: 'feat/ttl', owner: 'alice', ttlSeconds: 100 });
  clock.advanceSeconds(10);
  kernel.tick();
  assert.equal(kernel.get(env.id).status, 'active');
  clock.advanceSeconds(100);
  const result = kernel.tick();
  assert.deepEqual(result.reclaimed, [env.id]);
  assert.equal(kernel.get(env.id).status, 'reclaimed');
  assert.equal(store.listActiveByOwner('alice').length, 0);
  const transitions = store.listTransitions(env.id).map((t) => [t.fromStatus, t.toStatus]);
  assert.deepEqual(transitions, [['none', 'deploying'], ['deploying', 'active'], ['active', 'reclaimed']]);
});

test('renew: extends expiry once, second renew rejected', async () => {
  const { kernel, clock } = makeKernel({ deploySeconds: 10 });
  const { env } = await kernel.create({ branch: 'feat/renew', owner: 'alice', ttlSeconds: 100 });
  clock.advanceSeconds(10);
  kernel.tick();
  clock.advanceSeconds(90);
  const renewed = kernel.renew(env.id);
  assert.equal(renewed.renewed, true);
  assert.equal(renewed.expiresAt, env.expiresAt + 100_000);
  clock.advanceSeconds(99);
  kernel.tick();
  assert.equal(kernel.get(env.id).status, 'active', 'renewal must prevent reclaim at original expiry');
  const err = capture<InvalidStateError>(() => kernel.renew(env.id));
  assert.ok(err instanceof InvalidStateError);
  assert.equal(err.code, 'ALREADY_RENEWED');
  clock.advanceSeconds(1);
  kernel.tick();
  assert.equal(kernel.get(env.id).status, 'reclaimed', 'env reclaims exactly at renewed expiry');
});

test('renew: rejected while deploying', async () => {
  const { kernel } = makeKernel({ deploySeconds: 60 });
  const { env } = await kernel.create({ branch: 'feat/r2', owner: 'alice' });
  const err = capture<InvalidStateError>(() => kernel.renew(env.id));
  assert.ok(err instanceof InvalidStateError);
  assert.equal(err.code, 'ENV_NOT_ACTIVE');
});

test('quota: third active env rejected naming current occupancy', async () => {
  const { kernel } = makeKernel({ quotaPerOwner: 2 });
  const e1 = await kernel.create({ branch: 'b1', owner: 'bob' });
  const e2 = await kernel.create({ branch: 'b2', owner: 'bob' });
  const err = await kernel.create({ branch: 'b3', owner: 'bob' })
    .then(() => { throw new Error('expected rejection'); }, (e) => e as QuotaExceededError);
  assert.ok(err instanceof QuotaExceededError);
  assert.equal(err.category, 'quota_exceeded');
  assert.equal(err.details.quota, 2);
  assert.deepEqual(err.details.activeEnvIds, [e1.env.id, e2.env.id]);
  const ok = await kernel.create({ branch: 'b3', owner: 'carol' });
  assert.equal(ok.env.branch, 'b3');
});

test('quota: reclaimed env frees the slot', async () => {
  const { kernel, clock } = makeKernel({ quotaPerOwner: 1, deploySeconds: 0 });
  await kernel.create({ branch: 'only', owner: 'bob', ttlSeconds: 50 });
  kernel.tick();
  clock.advanceSeconds(50);
  kernel.tick();
  const again = await kernel.create({ branch: 'only', owner: 'bob' });
  assert.equal(again.idempotent, false);
});

test('delete lock: deploying env cannot be deleted without force', async () => {
  const { kernel } = makeKernel({ deploySeconds: 60 });
  const { env } = await kernel.create({ branch: 'feat/lock', owner: 'alice' });
  const err = await kernel.delete(env.id)
    .then(() => { throw new Error('expected rejection'); }, (e) => e as InvalidStateError);
  assert.ok(err instanceof InvalidStateError);
  assert.equal(err.category, 'conflict');
  assert.equal(err.code, 'DEPLOY_IN_PROGRESS');
  assert.equal(kernel.get(env.id).status, 'deploying');
});

test('force delete: allowed during deploy, audited with reason', async () => {
  const { kernel, store } = makeKernel({ deploySeconds: 60 });
  const { env } = await kernel.create({ branch: 'feat/force', owner: 'alice' });
  const deleted = await kernel.delete(env.id, { force: true, reason: 'stale deploy wedged', actor: 'ops-dana' });
  assert.equal(deleted.status, 'deleted');
  const audit = store.listAudit(env.id);
  const forced = audit.filter((a) => a.action === 'force_delete');
  assert.equal(forced.length, 1);
  assert.equal(forced[0].reason, 'stale deploy wedged');
  assert.equal(forced[0].actor, 'ops-dana');
  assert.equal(forced[0].details.statusAtDelete, 'deploying');
});

test('force delete: missing reason is a validation error', async () => {
  const { kernel } = makeKernel({ deploySeconds: 60 });
  const { env } = await kernel.create({ branch: 'feat/f2', owner: 'alice' });
  const err = await kernel.delete(env.id, { force: true })
    .then(() => { throw new Error('expected rejection'); }, (e) => e as Error);
  assert.match(err.message, /reason/);
});

test('delete: active env deletes normally; double delete rejected', async () => {
  const { kernel, clock } = makeKernel({ deploySeconds: 0 });
  const { env } = await kernel.create({ branch: 'feat/del', owner: 'alice' });
  kernel.tick();
  clock.advanceSeconds(1);
  const deleted = await kernel.delete(env.id);
  assert.equal(deleted.status, 'deleted');
  const err = await kernel.delete(env.id)
    .then(() => { throw new Error('expected rejection'); }, (e) => e as InvalidStateError);
  assert.ok(err instanceof InvalidStateError);
  assert.equal(err.code, 'ENV_ALREADY_TERMINATED');
});

test('not found: unknown id raises not_found category', async () => {
  const { kernel } = makeKernel();
  const err = await kernel.delete('env-00000000')
    .then(() => { throw new Error('expected rejection'); }, (e) => e as NotFoundError);
  assert.ok(err instanceof NotFoundError);
  assert.equal(err.category, 'not_found');
  assert.ok(capture(() => kernel.renew('env-00000000')) instanceof NotFoundError);
});

test('mutex: concurrent creates on same branch yield one env', async () => {
  const { kernel } = makeKernel();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => kernel.create({ branch: 'feat/race', owner: 'alice' })),
  );
  const ids = new Set(results.map((r) => r.env.id));
  assert.equal(ids.size, 1);
  assert.equal(kernel.list({ branch: 'feat/race' }).length, 1);
});

test('run log: operations carry runId, key states and reasons', async () => {
  const { kernel, sink } = makeKernel({ deploySeconds: 60 });
  const { env } = await kernel.create({ branch: 'feat/log', owner: 'alice' });
  await kernel.delete(env.id).catch(() => undefined);
  const lines = sink.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const rejected = lines.find((l) => l.event === 'delete.rejected');
  assert.ok(rejected, 'expected a delete.rejected log line');
  assert.match(rejected.runId as string, /^run-\d{4}$/);
  assert.equal(rejected.envId, env.id);
  assert.match(rejected.reason as string, /deployment in progress/);
});
