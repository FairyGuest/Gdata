import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapshotEngine } from "../src/core/engine.ts";
import { SqliteSnapshotStore } from "../src/store/sqlite.ts";
import { AppError } from "../src/contract/errors.ts";

const LIMITS = { maxDiffEntries: 100, maxSerializedBytes: 10_000 };

function makeEngine() {
  const store = new SqliteSnapshotStore(":memory:");
  const logs: Array<Record<string, unknown>> = [];
  const engine = new SnapshotEngine(store, LIMITS, (level, event, fields) => {
    logs.push({ level, event, ...fields });
  });
  return { engine, store, logs };
}

test("first compare auto-creates the snapshot", () => {
  const { engine } = makeEngine();
  const res = engine.compare({ key: "k1", data: { a: 1 }, ignorePaths: [], createIfMissing: true, updateOnMismatch: false });
  assert.equal(res.status, "created");
  assert.match(res.runId, /^[0-9a-f-]{36}$/);
  const second = engine.compare({ key: "k1", data: { a: 1 }, ignorePaths: [], createIfMissing: true, updateOnMismatch: false });
  assert.equal(second.status, "passed");
});

test("mismatch returns structured field-level diff", () => {
  const { engine } = makeEngine();
  engine.compare({ key: "k2", data: { user: { address: { city: "beijing" } } }, ignorePaths: [], createIfMissing: true, updateOnMismatch: false });
  const res = engine.compare({ key: "k2", data: { user: { address: { city: "shanghai" } } }, ignorePaths: [], createIfMissing: true, updateOnMismatch: false });
  assert.equal(res.status, "failed");
  assert.deepEqual(res.diff, [
    { path: "user.address.city", kind: "changed", before: "beijing", after: "shanghai" },
  ]);
});

test("ignored paths suppress differences and pass", () => {
  const { engine } = makeEngine();
  engine.compare({ key: "k3", data: { id: 1, ts: 1000 }, ignorePaths: [], createIfMissing: true, updateOnMismatch: false });
  const res = engine.compare({ key: "k3", data: { id: 1, ts: 2000 }, ignorePaths: ["ts"], createIfMissing: true, updateOnMismatch: false });
  assert.equal(res.status, "passed");
  assert.equal(res.reason, "differences exist only on ignored paths");
});

test("createIfMissing=false on absent snapshot throws STATE_CONFLICT", () => {
  const { engine } = makeEngine();
  assert.throws(
    () => engine.compare({ key: "nope", data: {}, ignorePaths: [], createIfMissing: false, updateOnMismatch: false }),
    (err: unknown) => err instanceof AppError && err.category === "STATE_CONFLICT",
  );
});

test("force update requires existing snapshot, then compare passes", () => {
  const { engine } = makeEngine();
  assert.throws(
    () => engine.forceUpdate({ key: "k4", data: { v: 1 } }),
    (err: unknown) => err instanceof AppError && err.category === "STATE_CONFLICT",
  );
  engine.compare({ key: "k4", data: { v: 1 }, ignorePaths: [], createIfMissing: true, updateOnMismatch: false });
  const upd = engine.forceUpdate({ key: "k4", data: { v: 2 } });
  assert.equal(upd.status, "updated");
  const res = engine.compare({ key: "k4", data: { v: 2 }, ignorePaths: [], createIfMissing: true, updateOnMismatch: false });
  assert.equal(res.status, "passed");
});

test("updateOnMismatch rewrites baseline and reports diff", () => {
  const { engine } = makeEngine();
  engine.compare({ key: "k5", data: { v: 1 }, ignorePaths: [], createIfMissing: true, updateOnMismatch: false });
  const res = engine.compare({ key: "k5", data: { v: 2 }, ignorePaths: [], createIfMissing: true, updateOnMismatch: true });
  assert.equal(res.status, "updated");
  assert.deepEqual(res.diff, [{ path: "v", kind: "changed", before: 1, after: 2 }]);
  const again = engine.compare({ key: "k5", data: { v: 2 }, ignorePaths: [], createIfMissing: true, updateOnMismatch: false });
  assert.equal(again.status, "passed");
});

test("oversized serialized payload throws RESOURCE_EXHAUSTED", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const engine = new SnapshotEngine(store, { maxDiffEntries: 100, maxSerializedBytes: 16 });
  assert.throws(
    () => engine.compare({ key: "big", data: { payload: "x".repeat(100) }, ignorePaths: [], createIfMissing: true, updateOnMismatch: false }),
    (err: unknown) => err instanceof AppError && err.category === "RESOURCE_EXHAUSTED",
  );
});

test("run records persist runId, status and reason for replay", () => {
  const { engine } = makeEngine();
  engine.compare({ key: "k6", data: { v: 1 }, ignorePaths: [], createIfMissing: true, updateOnMismatch: false });
  const failed = engine.compare({ key: "k6", data: { v: 2 }, ignorePaths: [], createIfMissing: true, updateOnMismatch: false });
  const runs = engine.listRuns("k6");
  assert.equal(runs.length, 2);
  const replayed = engine.getRun(failed.runId);
  assert.equal(replayed.status, "failed");
  assert.equal(replayed.reason, "1 field difference(s) detected");
  assert.equal(replayed.key, "k6");
});

test("deleting a missing snapshot throws STATE_CONFLICT", () => {
  const { engine } = makeEngine();
  assert.throws(
    () => engine.deleteSnapshot("ghost"),
    (err: unknown) => err instanceof AppError && err.category === "STATE_CONFLICT",
  );
});
