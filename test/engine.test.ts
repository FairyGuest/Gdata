import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/core/engine.js";
import { ServiceError } from "../src/domain/types.js";

function makeEngine() {
  const events: { action: string; detail: Record<string, unknown> }[] = [];
  const engine = new Engine({ runId: "test-run", onEvent: (e) => events.push({ action: e.action, detail: e.detail }) });
  return { engine, events };
}

describe("quota enforcement and queue draining", () => {
  it("rejects with shortfall when namespace quota is full, then drains queue after release", () => {
    const { engine } = makeEngine();
    engine.registerNode("n1", { cpu: 4, memoryMb: 4096 });
    engine.createNamespace("ns", { cpu: 2, memoryMb: 2048 });

    engine.placeWorkload("w1", "ns", { cpu: 2, memoryMb: 2048 });

    // quota full -> rejected with exact shortfall per dimension
    let err: ServiceError | null = null;
    try {
      engine.placeWorkload("w2", "ns", { cpu: 1, memoryMb: 1024 });
    } catch (e) {
      err = e as ServiceError;
    }
    assert.ok(err instanceof ServiceError);
    assert.equal(err.kind, "QUOTA_EXCEEDED");
    assert.deepEqual(err.details, { namespace: "ns", shortfall: { cpu: 1, memoryMb: 1024 } });

    // capacity-blocked (w1 still holds 2/2048 on n1, only 2/2048 free) but quota-ok -> queued
    engine.createNamespace("big", { cpu: 100, memoryMb: 100000 });
    const d = engine.placeWorkload("w3", "big", { cpu: 3, memoryMb: 3072 });
    assert.equal(d.outcome, "queued");
    assert.deepEqual(engine.getQueue(), ["w3"]);

    // releasing w1 frees the whole node -> queued w3 drains FIFO onto n1
    engine.deleteWorkload("w1");
    assert.deepEqual(engine.getQueue(), []);
    const w3 = engine.getWorkloads().find((w) => w.id === "w3");
    assert.equal(w3?.status, "running");
    assert.equal(w3?.nodeId, "n1");
    assert.equal(engine.audit().ok, true);
  });
});

describe("first-fit determinism", () => {
  it("same input sequence yields the same placement decisions", () => {
    const run = () => {
      const { engine } = makeEngine();
      engine.registerNode("a", { cpu: 2, memoryMb: 2048 });
      engine.registerNode("b", { cpu: 4, memoryMb: 4096 });
      engine.registerNode("c", { cpu: 4, memoryMb: 4096 });
      engine.createNamespace("ns", { cpu: 64, memoryMb: 65536 });
      const out: (string | null)[] = [];
      out.push(engine.placeWorkload("w1", "ns", { cpu: 1, memoryMb: 1024 }).nodeId); // a (1/2 used)
      out.push(engine.placeWorkload("w2", "ns", { cpu: 3, memoryMb: 1024 }).nodeId); // b (a has only 1 cpu free)
      out.push(engine.placeWorkload("w3", "ns", { cpu: 1, memoryMb: 1024 }).nodeId); // a (now full)
      out.push(engine.placeWorkload("w4", "ns", { cpu: 2, memoryMb: 2048 }).nodeId); // c (a full, b has 1 cpu free)
      return out;
    };
    const expected = ["a", "b", "a", "c"];
    assert.deepEqual(run(), expected);
    assert.deepEqual(run(), expected); // deterministic replay
  });
});

describe("namespace cascade eviction", () => {
  it("evicts all workloads, releases node capacity and quota, traceable per workload", () => {
    const { engine, events } = makeEngine();
    engine.registerNode("n1", { cpu: 8, memoryMb: 8192 });
    engine.createNamespace("keep", { cpu: 4, memoryMb: 4096 });
    engine.createNamespace("drop", { cpu: 4, memoryMb: 4096 });
    engine.placeWorkload("k1", "keep", { cpu: 2, memoryMb: 2048 });
    engine.placeWorkload("d1", "drop", { cpu: 2, memoryMb: 2048 });
    engine.placeWorkload("d2", "drop", { cpu: 1, memoryMb: 1024 });

    const evictions = engine.deleteNamespace("drop");
    assert.deepEqual(evictions.map((e) => e.workloadId).sort(), ["d1", "d2"]);
    for (const e of evictions) {
      assert.equal(e.nodeId, "n1");
      assert.equal(e.reason, "namespace.deleted");
    }
    // per-workload trace exists in the event log
    const evictedEvents = events.filter((e) => e.action === "workload.evicted");
    assert.deepEqual(evictedEvents.map((e) => e.detail.workloadId).sort(), ["d1", "d2"]);

    // capacity released back to the node, quota of "keep" untouched
    assert.deepEqual(engine.getNodes()[0].used, { cpu: 2, memoryMb: 2048 });
    assert.equal(engine.getNamespaces().length, 1);
    assert.equal(engine.getNamespaces()[0].name, "keep");
    assert.equal(engine.audit().ok, true);
  });
});

describe("conservation accounting", () => {
  it("sum of running allocations equals node used equals namespace used after mixed ops", () => {
    const { engine } = makeEngine();
    engine.registerNode("n1", { cpu: 8, memoryMb: 8192 });
    engine.registerNode("n2", { cpu: 8, memoryMb: 8192 });
    engine.createNamespace("x", { cpu: 6, memoryMb: 6144 });
    engine.createNamespace("y", { cpu: 6, memoryMb: 6144 });
    engine.placeWorkload("a", "x", { cpu: 2, memoryMb: 2048 });
    engine.placeWorkload("b", "y", { cpu: 2, memoryMb: 2048 });
    engine.placeWorkload("c", "x", { cpu: 2, memoryMb: 2048 });
    engine.deleteWorkload("b");
    engine.placeWorkload("d", "y", { cpu: 3, memoryMb: 3072 });

    assert.deepEqual(engine.audit(), {
      ok: true,
      nodeDelta: { cpu: 0, memoryMb: 0 },
      namespaceDelta: { cpu: 0, memoryMb: 0 },
    });

    // independent recomputation (not derived from engine internals)
    const running = engine.getWorkloads().filter((w) => w.status === "running");
    const sumCpu = running.reduce((s, w) => s + w.request.cpu, 0);
    const nodeCpu = engine.getNodes().reduce((s, n) => s + n.used.cpu, 0);
    const nsCpu = engine.getNamespaces().reduce((s, n) => s + n.used.cpu, 0);
    assert.equal(sumCpu, 7);
    assert.equal(nodeCpu, sumCpu);
    assert.equal(nsCpu, sumCpu);
  });
});

describe("error contracts", () => {
  it("duplicate namespace -> CONFLICT", () => {
    const { engine } = makeEngine();
    engine.createNamespace("dup", { cpu: 1, memoryMb: 1 });
    assert.throws(
      () => engine.createNamespace("dup", { cpu: 1, memoryMb: 1 }),
      (e: unknown) => e instanceof ServiceError && e.kind === "CONFLICT",
    );
  });

  it("placing into a missing namespace -> NOT_FOUND", () => {
    const { engine } = makeEngine();
    assert.throws(
      () => engine.placeWorkload("w", "ghost", { cpu: 1, memoryMb: 1 }),
      (e: unknown) => e instanceof ServiceError && e.kind === "NOT_FOUND",
    );
  });

  it("deleting unknown workload/namespace -> NOT_FOUND", () => {
    const { engine } = makeEngine();
    assert.throws(
      () => engine.deleteWorkload("nope"),
      (e: unknown) => e instanceof ServiceError && e.kind === "NOT_FOUND",
    );
    assert.throws(
      () => engine.deleteNamespace("nope"),
      (e: unknown) => e instanceof ServiceError && e.kind === "NOT_FOUND",
    );
  });
});
