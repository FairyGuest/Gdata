// Kernel lifecycle tests. Expected values are hard-coded (not derived from
// the implementation under test) and failures assert concrete error codes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualClock } from "../src/clock.ts";
import { LeaseKernel } from "../src/kernel.ts";
import { SqliteLeaseStore } from "../src/sqliteStore.ts";
import { AppError } from "../src/errors.ts";

const CFG = { portMin: 20000, portMax: 20002, leaseTtlMs: 1000 };

function makeKernel(start = 1_000_000) {
  const clock = new VirtualClock(start);
  const store = new SqliteLeaseStore(":memory:");
  let seq = 0;
  const kernel = new LeaseKernel({ clock, store, config: CFG, idGen: () => "L" + (++seq) });
  return { clock, store, kernel };
}

function assertAppError(fn: () => unknown, code: string): AppError {
  try { fn(); } catch (err) {
    assert.ok(err instanceof AppError, "expected AppError, got " + String(err));
    assert.equal((err as AppError).code, code);
    return err as AppError;
  }
  assert.fail("expected AppError " + code + " but call succeeded");
}

test("auto allocation picks smallest free port and never duplicates", () => {
  const { kernel, store } = makeKernel();
  const a = kernel.register({ target: "10.0.0.1:80" });
  const b = kernel.register({ target: "10.0.0.2:80" });
  const c = kernel.register({ target: "10.0.0.3:80" });
  assert.equal(a.port, 20000);
  assert.equal(b.port, 20001);
  assert.equal(c.port, 20002);
  assert.equal(new Set([a.port, b.port, c.port]).size, 3);
  // range exhausted -> RESOURCE_EXHAUSTED
  assertAppError(() => kernel.register({ target: "10.0.0.4:80" }), "RESOURCE_EXHAUSTED");
  store.close();
});

test("preferred port conflict returns PORT_CONFLICT with current occupant", () => {
  const { kernel, store } = makeKernel();
  const first = kernel.register({ target: "10.0.0.1:80", preferredPort: 20001 });
  assert.equal(first.port, 20001);
  const err = assertAppError(
    () => kernel.register({ target: "10.0.0.2:80", preferredPort: 20001 }), "PORT_CONFLICT");
  const details = err.details as { port: number; occupant: { leaseId: string; target: string } };
  assert.equal(details.port, 20001);
  assert.equal(details.occupant.leaseId, first.leaseId);
  assert.equal(details.occupant.target, "10.0.0.1:80");
  // out-of-range preference is an input error, not a conflict
  assertAppError(() => kernel.register({ target: "t", preferredPort: 20009 }), "INPUT_ERROR");
  store.close();
});

test("expired lease is auto-reclaimed and its port is reused", () => {
  const { kernel, clock, store } = makeKernel();
  const a = kernel.register({ target: "10.0.0.1:80" }); // port 20000, expires at t+1000
  clock.advance(1001); // now strictly past expiresAt
  const b = kernel.register({ target: "10.0.0.2:80" }); // triggers sweep
  assert.equal(b.port, 20000, "freed port must be the smallest free port");
  const old = store.getById(a.leaseId)!;
  assert.equal(old.status, "expired");
  assert.equal(old.closedAt, 1_001_001);
  store.close();
});

test("heartbeat exactly at deadline succeeds; one ms later the lease is expired", () => {
  const { kernel, clock, store } = makeKernel();
  const a = kernel.register({ target: "10.0.0.1:80" }); // expires at 1_001_000
  clock.advance(1000); // exactly at expiresAt
  const renewed = kernel.heartbeat(a.leaseId);
  assert.equal(renewed.status, "active");
  assert.equal(renewed.lastHeartbeatAt, 1_001_000);
  assert.equal(renewed.expiresAt, 1_002_000, "expiry extends by ttl from last heartbeat");
  clock.advance(1001); // one ms past the new deadline
  const err = assertAppError(() => kernel.heartbeat(a.leaseId), "LEASE_NOT_ACTIVE");
  assert.equal((err.details as { status: string }).status, "expired");
  assert.equal(store.getById(a.leaseId)!.status, "expired");
  store.close();
});

test("explicit release frees the port immediately; later heartbeats fail", () => {
  const { kernel, store } = makeKernel();
  const a = kernel.register({ target: "10.0.0.1:80", preferredPort: 20002 });
  const released = kernel.release(a.leaseId);
  assert.equal(released.status, "released");
  const b = kernel.register({ target: "10.0.0.2:80", preferredPort: 20002 });
  assert.equal(b.port, 20002, "released port must be re-allocatable");
  const err = assertAppError(() => kernel.heartbeat(a.leaseId), "LEASE_NOT_ACTIVE");
  assert.equal((err.details as { status: string }).status, "released");
  // double release also fails
  assertAppError(() => kernel.release(a.leaseId), "LEASE_NOT_ACTIVE");
  store.close();
});

test("unknown lease id yields LEASE_NOT_FOUND", () => {
  const { kernel, store } = makeKernel();
  assertAppError(() => kernel.heartbeat("nope"), "LEASE_NOT_FOUND");
  assertAppError(() => kernel.release("nope"), "LEASE_NOT_FOUND");
  store.close();
});

test("forward table filters by target and status, distinguishing expired vs released", () => {
  const { kernel, clock, store } = makeKernel();
  const a = kernel.register({ target: "10.0.0.1:80" });
  const b = kernel.register({ target: "10.0.0.1:80" });
  kernel.release(b.leaseId);
  clock.advance(1001);
  kernel.register({ target: "10.0.0.9:80" }); // triggers sweep, expires a
  const all = kernel.forwardTable({ target: "10.0.0.1:80" });
  assert.equal(all.length, 2);
  const byId = new Map(all.map((e) => [e.leaseId, e]));
  assert.equal(byId.get(a.leaseId)!.status, "expired");
  assert.equal(byId.get(b.leaseId)!.status, "released");
  const releasedOnly = kernel.forwardTable({ status: "released" });
  assert.deepEqual(releasedOnly.map((e) => e.leaseId), [b.leaseId]);
  const entry = byId.get(a.leaseId)!;
  assert.equal(entry.port, 20000);
  assert.equal(entry.expiresAt, 1_001_000);
  store.close();
});

test("sqlite keeps full history queryable by port and status", () => {
  const { kernel, clock, store } = makeKernel();
  const a = kernel.register({ target: "t1" }); // 20000
  const b = kernel.register({ target: "t2" }); // 20001
  kernel.release(a.leaseId);
  clock.advance(1001);
  kernel.register({ target: "t3" }); // sweep expires b, takes 20000
  const onPort20000 = kernel.history({ port: 20000 });
  assert.equal(onPort20000.length, 2);
  assert.deepEqual(onPort20000.map((l) => l.status).sort(), ["active", "released"]);
  const expired = kernel.history({ status: "expired" });
  assert.deepEqual(expired.map((l) => l.leaseId), [b.leaseId]);
  store.close();
});

