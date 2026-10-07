// Independent lifecycle tests. Assertions check concrete outcomes and error
// categories, not just that calls succeed. Expected values are hard-coded
// here, not derived from the implementation under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleEngine } from '../src/core/engine.ts';
import { VirtualClock } from '../src/core/clock.ts';
import { EnvironmentStore } from '../src/store/sqlite.ts';
import { parseTemplate } from '../src/contract/template.ts';
import { ErrorCodes, LifecycleError } from '../src/contract/errors.ts';

const TEMPLATE = parseTemplate({
  name: 'webapp-stack',
  services: ['web', 'api', 'worker'],
  params: {
    'web.replicas': { type: 'number', default: 1 },
    'web.image': { type: 'string', default: 'web:1.4.0' },
    'api.enableDebug': { type: 'boolean', default: false },
    'worker.queue': { type: 'string', default: 'default' },
  },
  defaultTtlSeconds: 3600,
  maxTtlSeconds: 86400,
});

function setup() {
  const store = new EnvironmentStore(':memory:');
  const clock = new VirtualClock(1_000_000_000_000);
  const engine = new LifecycleEngine({
    template: TEMPLATE, store, clock, runId: 'test-run', maxActivePerUser: 2, maxRenewals: 1,
  });
  return { store, clock, engine };
}

function expectCode(err: unknown, code: string): LifecycleError {
  assert.ok(err instanceof LifecycleError, `expected LifecycleError, got ${err}`);
  assert.equal(err.code, code);
  return err;
}

test('create merges defaults and reports effective config', () => {
  const { engine } = setup();
  const { env, idempotent } = engine.create({ owner: 'alice', branch: 'feat/a', overrides: { 'web.replicas': 3 } });
  assert.equal(idempotent, false);
  assert.match(env.id, /^env-[0-9a-f]{8}$/);
  assert.equal(env.status, 'DEPLOYING');
  assert.deepEqual(env.params, {
    'web.replicas': 3,
    'web.image': 'web:1.4.0',
    'api.enableDebug': false,
    'worker.queue': 'default',
  });
  assert.equal(env.ttlSeconds, 3600);
  assert.equal(env.expiresAt - env.createdAt, 3_600_000);
});

test('idempotent create: same branch + same params returns existing id', () => {
  const { engine } = setup();
  const first = engine.create({ owner: 'alice', branch: 'feat/a', overrides: { 'web.replicas': 2 } });
  const second = engine.create({ owner: 'alice', branch: 'feat/a', overrides: { 'web.replicas': 2 } });
  assert.equal(second.idempotent, true);
  assert.equal(second.env.id, first.env.id);
  // explicit-default override is equivalent to no override
  const third = engine.create({ owner: 'alice', branch: 'feat/b' });
  const fourth = engine.create({ owner: 'alice', branch: 'feat/b', overrides: { 'web.replicas': 1 } });
  assert.equal(fourth.env.id, third.env.id);
});

test('same branch with different params -> 409 category with existing id', () => {
  const { engine } = setup();
  const first = engine.create({ owner: 'alice', branch: 'feat/a', overrides: { 'web.replicas': 2 } });
  const err = expectCode(
    (() => { try { engine.create({ owner: 'alice', branch: 'feat/a', overrides: { 'web.replicas': 5 } }); } catch (e) { return e; } })(),
    ErrorCodes.BRANCH_PARAM_CONFLICT,
  );
  assert.equal(err.details.existingEnvId, first.env.id);
});

test('unknown parameter rejected and named', () => {
  const { engine } = setup();
  const err = expectCode(
    (() => { try { engine.create({ owner: 'alice', branch: 'feat/a', overrides: { 'db.host': 'x' } }); } catch (e) { return e; } })(),
    ErrorCodes.UNKNOWN_PARAM,
  );
  assert.equal(err.details.param, 'db.host');
});

test('type mismatch rejected with param, expected and actual', () => {
  const { engine } = setup();
  const err = expectCode(
    (() => { try { engine.create({ owner: 'alice', branch: 'feat/a', overrides: { 'web.replicas': 'three' } }); } catch (e) { return e; } })(),
    ErrorCodes.PARAM_TYPE_MISMATCH,
  );
  assert.deepEqual(err.details, { param: 'web.replicas', expected: 'number', actual: 'string' });
});

test('invalid ttl rejected', () => {
  const { engine } = setup();
  const err = expectCode(
    (() => { try { engine.create({ owner: 'alice', branch: 'feat/a', ttlSeconds: 999999 }); } catch (e) { return e; } })(),
    ErrorCodes.INVALID_TTL,
  );
  assert.equal(err.details.maxTtlSeconds, 86400);
});

test('expiry sweep reclaims and releases quota; renew extends once only', () => {
  const { engine, clock, store } = setup();
  const a = engine.create({ owner: 'alice', branch: 'feat/a', ttlSeconds: 60 }).env;
  const b = engine.create({ owner: 'alice', branch: 'feat/b', ttlSeconds: 60 }).env;
  // quota full: 2/2
  const quotaErr = expectCode(
    (() => { try { engine.create({ owner: 'alice', branch: 'feat/c' }); } catch (e) { return e; } })(),
    ErrorCodes.QUOTA_EXCEEDED,
  );
  assert.deepEqual(quotaErr.details, { owner: 'alice', used: 2, max: 2 });

  // renew a once: expiry moves from t+60s to t+120s
  const renewed = engine.renew(a.id);
  assert.equal(renewed.renewalsUsed, 1);
  assert.equal(renewed.expiresAt, a.createdAt + 120_000);
  // second renewal rejected
  expectCode(
    (() => { try { engine.renew(a.id); } catch (e) { return e; } })(),
    ErrorCodes.INVALID_STATE,
  );

  // advance past b's deadline but not a's renewed deadline
  clock.advanceSeconds(61);
  assert.deepEqual(engine.sweep(), [b.id]);
  assert.equal(engine.get(b.id).status, 'RECLAIMED');
  assert.equal(engine.get(a.id).status, 'DEPLOYING');

  // quota slot released: alice can create again
  const c = engine.create({ owner: 'alice', branch: 'feat/c' });
  assert.equal(c.idempotent, false);

  // reclaimed env cannot be renewed
  expectCode(
    (() => { try { engine.renew(b.id); } catch (e) { return e; } })(),
    ErrorCodes.INVALID_STATE,
  );

  // transitions recorded for b
  const transitions = store.transitions(b.id);
  assert.deepEqual(transitions.map((t) => [t.from, t.to]), [[null, 'DEPLOYING'], ['DEPLOYING', 'RECLAIMED']]);
});

test('delete lock while DEPLOYING; force delete requires reason and is audited', () => {
  const { engine, store } = setup();
  const env = engine.create({ owner: 'alice', branch: 'feat/a' }).env;

  // plain delete while DEPLOYING -> DELETE_LOCKED
  const locked = expectCode(
    (() => { try { engine.remove(env.id); } catch (e) { return e; } })(),
    ErrorCodes.DELETE_LOCKED,
  );
  assert.equal(locked.details.envId, env.id);

  // force without reason -> FORCE_REASON_REQUIRED
  expectCode(
    (() => { try { engine.remove(env.id, { force: true }); } catch (e) { return e; } })(),
    ErrorCodes.FORCE_REASON_REQUIRED,
  );

  // force with reason -> deleted, audit carries the reason
  const deleted = engine.remove(env.id, { force: true, reason: 'deploy hung on image pull' });
  assert.equal(deleted.status, 'DELETED');
  const audit = store.auditLog({ envId: env.id, action: 'delete' });
  const forced = audit.filter((e) => e.outcome === 'ALLOW');
  assert.equal(forced.length, 1);
  assert.equal(forced[0].details.force, true);
  assert.equal(forced[0].details.forceReason, 'deploy hung on image pull');
  assert.match(forced[0].reason, /FORCE DELETE/);

  // deleting again -> INVALID_STATE
  expectCode(
    (() => { try { engine.remove(env.id); } catch (e) { return e; } })(),
    ErrorCodes.INVALID_STATE,
  );
});

test('delete of ACTIVE env succeeds without force', () => {
  const { engine } = setup();
  const env = engine.create({ owner: 'alice', branch: 'feat/a' }).env;
  engine.markActive(env.id);
  const deleted = engine.remove(env.id);
  assert.equal(deleted.status, 'DELETED');
  // quota released
  const again = engine.create({ owner: 'alice', branch: 'feat/b' });
  assert.equal(again.idempotent, false);
});

test('unknown env id -> ENV_NOT_FOUND', () => {
  const { engine } = setup();
  expectCode(
    (() => { try { engine.get('env-00000000'); } catch (e) { return e; } })(),
    ErrorCodes.ENV_NOT_FOUND,
  );
});

test('query by branch and status', () => {
  const { engine } = setup();
  engine.create({ owner: 'alice', branch: 'feat/a' });
  const b = engine.create({ owner: 'alice', branch: 'feat/b' }).env;
  engine.markActive(b.id);
  assert.equal(engine.query({ branch: 'feat/a' }).length, 1);
  assert.deepEqual(engine.query({ status: 'ACTIVE' }).map((e) => e.id), [b.id]);
  assert.equal(engine.query({ status: 'DEPLOYING' }).length, 1);
});

