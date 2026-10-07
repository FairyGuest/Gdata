// Kernel-level lifecycle tests. Expected values are literal, hand-computed
// constants (ports, timestamps, error codes), never derived from the kernel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LeaseKernel } from "../src/kernel.ts";
import { SqliteLeaseStore } from "../src/store.ts";
import { VirtualClock } from "../src/clock.ts";
import { LeaseError } from "../src/contract.ts";

const START = 1_000_000;
const TTL = 100;
const OPTS = { portStart: 5000, portEnd: 5002, leaseTtlMs: TTL };

function setup() {
  const store = new SqliteLeaseStore(":memory:");
  const clock = new VirtualClock(START);
  const kernel = new LeaseKernel(store, clock, OPTS);
  return { store, clock, kernel };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof LeaseError) return err.code;
    throw err;
  }
  return "NO_ERROR";
}

test("auto allocation is ascending, unique, and exhausts with RESOURCE_EXHAUSTED", () => {
  const { kernel } = setup();
  const a = kernel.register({ target: "svc-a" });
  const b = kernel.register({ target: "svc-b" });
  const c = kernel.register({ target: "svc-c" });
  assert.deepEqual([a.port, b.port, c.port], [5000, 5001, 5002]);
  assert.equal(new Set([a.port, b.port, c.port]).size, 3);
  assert.equal(a.expiresAt, START + TTL);
  assert.equal(codeOf(() => kernel.register({ target: "svc-d" })), "RESOURCE_EXHAUSTED");
});

test("preferred port: granted when free, 409 PORT_CONFLICT with occupant when taken", () => {
  const { kernel } = setup();
  const a = kernel.register({ target: "svc-a", preferredPort: 5001 });
  assert.equal(a.port, 5001);
  let details: unknown;
  try {
    kernel.register({ target: "svc-b", preferredPort: 5001 });
    throw new Error("should have thrown");
  } catch (err) {
    if (!(err instanceof LeaseError)) throw err;
    assert.equal(err.code, "PORT_CONFLICT");
    details = err.details;
  }
  const occ = (details as { occupant: { leaseId: string } }).occupant;
  assert.equal(occ.leaseId, a.id);
  assert.equal(codeOf(() => kernel.register({ target: "svc-x", preferredPort: 6000 })), "INVALID_INPUT");
});

test("expiry reclaims the port and a new registration reuses it", () => {
  const { kernel, clock } = setup();
  const a = kernel.register({ target: "svc-a" });
  assert.equal(a.port, 5000);
  clock.advance(TTL + 1); // now = START+101 > expiresAt START+100
  const b = kernel.register({ target: "svc-b" });
  assert.equal(b.port, 5000, "freed port must be reused");
  assert.notEqual(b.id, a.id);
  const old = kernel.history({ port: 5000 }).find((l) => l.id === a.id);
  assert.equal(old?.status, "expired");
  assert.equal(old?.closeReason, "ttl-expired");
});

test("heartbeat boundary: exactly at deadline renews, one tick late is expired", () => {
  const { kernel, clock } = setup();
  const a = kernel.register({ target: "svc-a" }); // expiresAt = START+100
  clock.advance(TTL); // now == expiresAt exactly
  const renewed = kernel.heartbeat(a.id);
  assert.equal(renewed.status, "active");
  assert.equal(renewed.lastHeartbeatAt, START + TTL);
  assert.equal(renewed.expiresAt, START + 2 * TTL);
  clock.advance(TTL + 1); // one tick past the new deadline
  assert.equal(codeOf(() => kernel.heartbeat(a.id)), "LEASE_EXPIRED");
  const dead = kernel.history({}).find((l) => l.id === a.id);
  assert.equal(dead?.status, "expired");
});

test("explicit release frees the port instantly; later heartbeats fail as LEASE_RELEASED", () => {
  const { kernel } = setup();
  const a = kernel.register({ target: "svc-a", preferredPort: 5002 });
  const released = kernel.release(a.id);
  assert.equal(released.status, "released");
  assert.equal(released.closeReason, "explicit-release");
  assert.equal(codeOf(() => kernel.heartbeat(a.id)), "LEASE_RELEASED");
  assert.equal(codeOf(() => kernel.release(a.id)), "LEASE_NOT_ACTIVE");
  const b = kernel.register({ target: "svc-b", preferredPort: 5002 });
  assert.equal(b.port, 5002, "released port must be re-allocatable");
});

test("forwarding table filters by target and status; expired vs released stay distinct", () => {
  const { kernel, clock } = setup();
  const a = kernel.register({ target: "web", preferredPort: 5000 });
  const b = kernel.register({ target: "api", preferredPort: 5001 });
  kernel.release(b.id);
  clock.advance(TTL + 1); // expires a
  kernel.register({ target: "web2", preferredPort: 5000 }); // triggers sweep, reuses 5000

  const expiredRows = kernel.forwardingTable({ status: "expired" });
  assert.deepEqual(expiredRows.map((l) => l.id), [a.id]);
  const releasedRows = kernel.forwardingTable({ status: "released" });
  assert.deepEqual(releasedRows.map((l) => l.id), [b.id]);
  const webRows = kernel.forwardingTable({ target: "web" });
  assert.deepEqual(webRows.map((l) => l.id), [a.id]);
  const active = kernel.forwardingTable({ status: "active" });
  assert.equal(active.length, 1);
  assert.equal(active[0].target, "web2");
});

test("input and lookup failures carry distinct error codes", () => {
  const { kernel } = setup();
  assert.equal(codeOf(() => kernel.heartbeat("missing-id")), "LEASE_NOT_FOUND");
  assert.equal(codeOf(() => kernel.release("missing-id")), "LEASE_NOT_FOUND");
});

test("sqlite store keeps full history queryable by port and status", () => {
  const { kernel, store } = setup();
  const a = kernel.register({ target: "svc-a", preferredPort: 5000 });
  kernel.release(a.id);
  const b = kernel.register({ target: "svc-b", preferredPort: 5000 });
  const byPort = store.list({ port: 5000 });
  assert.deepEqual(byPort.map((l) => l.id), [a.id, b.id]);
  assert.deepEqual(byPort.map((l) => l.status), ["released", "active"]);
  assert.equal(store.countByStatus().released, 1);
  assert.equal(store.countByStatus().active, 1);
});


