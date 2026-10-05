import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapshotEngine } from "../src/core/engine.ts";
import { SqliteSnapshotStore } from "../src/store/sqliteStore.ts";
import { Logger } from "../src/diagnostics/logger.ts";
import { ServiceError } from "../src/diagnostics/errors.ts";

function makeEngine(maxSnapshots = 100) {
  const store = new SqliteSnapshotStore(":memory:");
  const logger = new Logger(undefined);
  const engine = new SnapshotEngine(store, logger, { maxSnapshots });
  return { engine, store };
}

test("first call auto-creates snapshot", () => {
  const { engine } = makeEngine();
  const res = engine.compare({ name: "s1", data: { a: 1 } }, "run-1");
  assert.equal(res.status, "created");
  assert.deepEqual(res.diffs, []);
  assert.equal(res.runId, "run-1");
});

test("matching call passes, mismatching call fails with field diffs", () => {
  const { engine } = makeEngine();
  engine.compare({ name: "s2", data: { user: { city: "Beijing" } } }, "r");
  const ok = engine.compare({ name: "s2", data: { user: { city: "Beijing" } } }, "r");
  assert.equal(ok.status, "passed");
  const bad = engine.compare({ name: "s2", data: { user: { city: "Shanghai" } } }, "r");
  assert.equal(bad.status, "failed");
  assert.deepEqual(bad.diffs, [
    { path: "user.city", type: "modified", before: "Beijing", after: "Shanghai" },
  ]);
});

test("ignored fields do not cause failure", () => {
  const { engine } = makeEngine();
  engine.compare({ name: "s3", data: { ts: 1, v: "a" } }, "r");
  const res = engine.compare({ name: "s3", data: { ts: 999, v: "a" }, ignorePaths: ["ts"] }, "r");
  assert.equal(res.status, "passed");
});

test("update flag force-overwrites snapshot", () => {
  const { engine } = makeEngine();
  engine.compare({ name: "s4", data: { v: 1 } }, "r");
  const upd = engine.compare({ name: "s4", data: { v: 2 }, update: true }, "r");
  assert.equal(upd.status, "updated");
  const res = engine.compare({ name: "s4", data: { v: 2 } }, "r");
  assert.equal(res.status, "passed");
});

test("explicit create on existing name throws STATE_CONFLICT", () => {
  const { engine } = makeEngine();
  engine.create("s5", { v: 1 }, "r");
  assert.throws(
    () => engine.create("s5", { v: 2 }, "r"),
    (e: unknown) => e instanceof ServiceError && e.category === "STATE_CONFLICT" && e.code === "SNAPSHOT_EXISTS",
  );
});

test("snapshot limit throws RESOURCE_EXHAUSTED", () => {
  const { engine } = makeEngine(1);
  engine.compare({ name: "only", data: 1 }, "r");
  assert.throws(
    () => engine.compare({ name: "overflow", data: 2 }, "r"),
    (e: unknown) => e instanceof ServiceError && e.category === "RESOURCE_EXHAUSTED" && e.code === "SNAPSHOT_LIMIT",
  );
});

test("get on missing snapshot throws STATE_CONFLICT/NOT_FOUND", () => {
  const { engine } = makeEngine();
  assert.throws(
    () => engine.get("nope", "r"),
    (e: unknown) => e instanceof ServiceError && e.category === "STATE_CONFLICT" && e.code === "SNAPSHOT_NOT_FOUND",
  );
});
