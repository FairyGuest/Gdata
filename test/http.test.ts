// HTTP contract tests: status codes and error bodies per endpoint.

import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualClock } from "../src/clock.ts";
import { LeaseKernel } from "../src/kernel.ts";
import { SqliteLeaseStore } from "../src/sqliteStore.ts";
import { buildServer } from "../src/server.ts";

function makeApp() {
  const clock = new VirtualClock(1_000_000);
  const store = new SqliteLeaseStore(":memory:");
  let seq = 0;
  const kernel = new LeaseKernel({
    clock, store, config: { portMin: 20000, portMax: 20001, leaseTtlMs: 1000 },
    idGen: () => "L" + (++seq),
  });
  return { clock, store, app: buildServer(kernel) };
}

test("register -> heartbeat -> release over HTTP with error mapping", async () => {
  const { app, clock, store } = makeApp();

  const bad = await app.inject({ method: "POST", url: "/tunnels", payload: {} });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, "INPUT_ERROR");

  const reg = await app.inject({ method: "POST", url: "/tunnels", payload: { target: "10.0.0.1:80" } });
  assert.equal(reg.statusCode, 201);
  assert.equal(reg.json().lease.port, 20000);
  const id = reg.json().lease.leaseId;

  const conflict = await app.inject({ method: "POST", url: "/tunnels", payload: { target: "x", preferredPort: 20000 } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, "PORT_CONFLICT");
  assert.equal(conflict.json().error.details.occupant.leaseId, id);

  const hb = await app.inject({ method: "POST", url: "/tunnels/" + id + "/heartbeat" });
  assert.equal(hb.statusCode, 200);
  assert.equal(hb.json().lease.status, "active");

  const rel = await app.inject({ method: "POST", url: "/tunnels/" + id + "/release" });
  assert.equal(rel.statusCode, 200);
  assert.equal(rel.json().lease.status, "released");

  const hbAfter = await app.inject({ method: "POST", url: "/tunnels/" + id + "/heartbeat" });
  assert.equal(hbAfter.statusCode, 409);
  assert.equal(hbAfter.code, undefined);
  assert.equal(hbAfter.json().error.code, "LEASE_NOT_ACTIVE");
  assert.equal(hbAfter.json().error.details.status, "released");
  assert.ok(hbAfter.json().error.runId, "error body carries a replayable run id");

  const missing = await app.inject({ method: "POST", url: "/tunnels/ghost/heartbeat" });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "LEASE_NOT_FOUND");

  clock.advance(5000);
  const reg2 = await app.inject({ method: "POST", url: "/tunnels", payload: { target: "10.0.0.2:80" } });
  assert.equal(reg2.json().lease.port, 20000, "released port is reused");

  const table = await app.inject({ method: "GET", url: "/forward-table?status=released" });
  assert.equal(table.statusCode, 200);
  assert.deepEqual(table.json().entries.map((e: { leaseId: string }) => e.leaseId), [id]);

  const badFilter = await app.inject({ method: "GET", url: "/forward-table?status=bogus" });
  assert.equal(badFilter.statusCode, 400);
  assert.equal(badFilter.json().error.code, "INPUT_ERROR");

  const hist = await app.inject({ method: "GET", url: "/leases?port=20000" });
  assert.equal(hist.statusCode, 200);
  assert.equal(hist.json().leases.length, 2);

  const diag = await app.inject({ method: "GET", url: "/diagnostics/state" });
  assert.equal(diag.statusCode, 200);
  assert.ok(Array.isArray(diag.json().recentLogs));
  assert.ok(diag.json().recentLogs.length > 0);

  store.close();
});

