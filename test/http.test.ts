import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildServer, BuiltApp } from "../src/http/server.js";

let built: BuiltApp;
before(() => {
  built = buildServer({ host: "127.0.0.1", port: 0, dbPath: ":memory:" });
});
after(async () => {
  await built.app.close();
  built.store.close();
});

describe("HTTP contract", () => {
  it("full lifecycle with distinct error statuses", async () => {
    const { app } = built;

    // validation failure: malformed resources
    let res = await app.inject({ method: "POST", url: "/nodes", payload: { id: "n1", capacity: { cpu: -1, memoryMb: 10 } } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.kind, "VALIDATION");

    await app.inject({ method: "POST", url: "/nodes", payload: { id: "n1", capacity: { cpu: 4, memoryMb: 4096 } } });
    res = await app.inject({ method: "POST", url: "/namespaces", payload: { name: "ns", quota: { cpu: 2, memoryMb: 2048 } } });
    assert.equal(res.statusCode, 201);

    // duplicate namespace -> 409
    res = await app.inject({ method: "POST", url: "/namespaces", payload: { name: "ns", quota: { cpu: 1, memoryMb: 1 } } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.kind, "CONFLICT");

    // place into missing namespace -> 404
    res = await app.inject({ method: "POST", url: "/workloads", payload: { id: "w0", namespace: "ghost", request: { cpu: 1, memoryMb: 1 } } });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.kind, "NOT_FOUND");

    // fill quota, then exceed -> 422 with shortfall
    res = await app.inject({ method: "POST", url: "/workloads", payload: { id: "w1", namespace: "ns", request: { cpu: 2, memoryMb: 2048 } } });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().decision.outcome, "placed");
    assert.equal(res.json().decision.nodeId, "n1");

    res = await app.inject({ method: "POST", url: "/workloads", payload: { id: "w2", namespace: "ns", request: { cpu: 1, memoryMb: 512 } } });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.kind, "QUOTA_EXCEEDED");
    assert.deepEqual(res.json().error.details.shortfall, { cpu: 1, memoryMb: 512 });

    // diagnostics: occupancy per namespace/node, audit clean
    res = await app.inject({ method: "GET", url: "/diag/state" });
    const state = res.json();
    assert.equal(state.audit.ok, true);
    assert.deepEqual(state.nodes[0].used, { cpu: 2, memoryMb: 2048 });
    assert.deepEqual(state.namespaces[0].used, { cpu: 2, memoryMb: 2048 });

    // history queryable by namespace and node
    res = await app.inject({ method: "GET", url: "/diag/history?namespace=ns" });
    assert.ok(res.json().history.length > 0);
    res = await app.inject({ method: "GET", url: "/diag/history?nodeId=n1" });
    assert.ok(res.json().history.some((h: { action: string }) => h.action === "workload.placed"));

    // delete releases both ledgers
    res = await app.inject({ method: "DELETE", url: "/workloads/w1" });
    assert.equal(res.json().deleted, "w1");
    assert.equal(res.json().nodeId, "n1");
    assert.deepEqual(res.json().released, { cpu: 2, memoryMb: 2048 });
    res = await app.inject({ method: "GET", url: "/diag/audit" });
    assert.equal(res.json().ok, true);
  });
});
