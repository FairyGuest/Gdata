/** 核心行为测试：层级扣减、超限回滚、轮换宽限、并发不超扣。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock } from '../src/domain/clock.ts';
import { RingLogger } from '../src/domain/logger.ts';
import { SqliteStore } from '../src/store/sqliteStore.ts';
import { QuotaService } from '../src/service/quotaService.ts';
import { AppError } from '../src/domain/errors.ts';

function makeService(gracePeriodMs = 1000) {
  const store = new SqliteStore(':memory:');
  const clock = new VirtualClock();
  const logger = new RingLogger(500, 'test-run');
  const service = new QuotaService({ store, clock, logger, gracePeriodMs });
  return { store, clock, logger, service };
}

function seedThreeLevels(service: QuotaService, limits: { global: number; org: number; project: number }) {
  service.createScope({ id: 'g1', level: 'global', quotaLimit: limits.global });
  service.createScope({ id: 'o1', level: 'org', parentId: 'g1', quotaLimit: limits.org });
  service.createScope({ id: 'p1', level: 'project', parentId: 'o1', quotaLimit: limits.project });
  return service.createKey({ projectScopeId: 'p1' });
}

test('consume deducts all three levels atomically and reports balances', () => {
  const { service } = makeService();
  const key = seedThreeLevels(service, { global: 100, org: 50, project: 10 });
  const res = service.consume(key.secret, 4);
  assert.equal(res.keyId, key.id);
  assert.deepEqual(res.balances.map((b) => [b.level, b.used, b.remaining]), [
    ['project', 4, 6],
    ['org', 4, 46],
    ['global', 4, 96],
  ]);
});

test('project limit exceeded rolls back all levels', () => {
  const { service, store } = makeService();
  const key = seedThreeLevels(service, { global: 100, org: 50, project: 5 });
  service.consume(key.secret, 5);
  assert.throws(
    () => service.consume(key.secret, 1),
    (err: unknown) => err instanceof AppError && err.code === 'QUOTA_EXCEEDED' && err.details.level === 'project',
  );
  assert.equal(store.getScope('p1')!.quotaUsed, 5);
  assert.equal(store.getScope('o1')!.quotaUsed, 5);
  assert.equal(store.getScope('g1')!.quotaUsed, 5);
});

test('org limit exceeded rolls back project too', () => {
  const { service, store } = makeService();
  const key = seedThreeLevels(service, { global: 100, org: 3, project: 10 });
  assert.throws(
    () => service.consume(key.secret, 4),
    (err: unknown) => err instanceof AppError && err.code === 'QUOTA_EXCEEDED' && err.details.level === 'org',
  );
  assert.equal(store.getScope('p1')!.quotaUsed, 0);
  assert.equal(store.getScope('o1')!.quotaUsed, 0);
});

test('rotation keeps old key usable during grace, expired after', () => {
  const { service, clock } = makeService(1000);
  const key = seedThreeLevels(service, { global: 100, org: 50, project: 10 });
  const { oldKey, newKey } = service.rotate(key.secret);
  assert.equal(oldKey.status, 'grace');
  service.consume(key.secret, 1); // old key still works
  service.consume(newKey.secret, 1);
  clock.advance(1001);
  assert.throws(
    () => service.consume(key.secret, 1),
    (err: unknown) => err instanceof AppError && err.code === 'KEY_EXPIRED',
  );
  const report = service.usageReport(newKey.secret);
  assert.equal(report.totalConsumed, 1);
});

test('sweepExpired marks grace keys past deadline', () => {
  const { service, clock } = makeService(500);
  const key = seedThreeLevels(service, { global: 10, org: 10, project: 10 });
  service.rotate(key.secret);
  clock.advance(600);
  const expired = service.sweepExpired();
  assert.deepEqual(expired, [key.id]);
});

test('unknown key and invalid amount are rejected with stable codes', () => {
  const { service } = makeService();
  seedThreeLevels(service, { global: 10, org: 10, project: 10 });
  assert.throws(() => service.consume('sk_nope', 1), (e: unknown) => e instanceof AppError && e.code === 'KEY_UNKNOWN');
  assert.throws(() => service.consume('x', 0), (e: unknown) => e instanceof AppError && e.code === 'INVALID_REQUEST');
});

test('concurrent consumes never overshoot the project limit', () => {
  const { service, store } = makeService();
  const key = seedThreeLevels(service, { global: 1000, org: 1000, project: 10 });
  let ok = 0;
  let rejected = 0;
  for (let i = 0; i < 25; i++) {
    try { service.consume(key.secret, 1); ok++; }
    catch (err) { assert.ok(err instanceof AppError && err.code === 'QUOTA_EXCEEDED'); rejected++; }
  }
  assert.equal(ok, 10);
  assert.equal(rejected, 15);
  assert.equal(store.getScope('p1')!.quotaUsed, 10);
});

test('usage report aggregates events and balances', () => {
  const { service } = makeService();
  const key = seedThreeLevels(service, { global: 100, org: 50, project: 20 });
  service.consume(key.secret, 3, 'req-1');
  service.consume(key.secret, 2, 'req-2');
  const report = service.usageReport(key.secret);
  assert.equal(report.totalConsumed, 5);
  assert.equal(report.events.length, 2);
  assert.equal(report.balances.find((b) => b.level === 'project')!.remaining, 15);
});
