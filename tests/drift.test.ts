import { test } from "node:test";
import assert from "node:assert/strict";
import { diffConfigs } from "../src/core/drift.ts";
import type { JsonObject } from "../src/contracts/types.ts";

const effective: JsonObject = {
  a: 1,
  b: { c: "x", d: [1, 2] },
  gone: true,
};

test("classifies all three drift kinds with dot paths", () => {
  const snapshot = {
    a: 2,                 // value_mismatch at "a"
    b: { c: "x", d: [1, 2] },
    // "gone" absent      // missing_required at "gone"
    extra: { deep: 1 },   // extra_in_snapshot at "extra"
  };
  const report = diffConfigs(effective, snapshot, "test");
  assert.equal(report.status, "DRIFT");
  assert.deepEqual(report.counts, { missing_required: 1, value_mismatch: 1, extra_in_snapshot: 1 });
  // severity order: missing_required > value_mismatch > extra_in_snapshot
  assert.deepEqual(
    report.drifts.map((d) => [d.kind, d.path]),
    [
      ["missing_required", "gone"],
      ["value_mismatch", "a"],
      ["extra_in_snapshot", "extra"],
    ],
  );
  const mismatch = report.drifts[1]!;
  assert.equal(mismatch.expected, 1);
  assert.equal(mismatch.actual, 2);
});

test("sorts by path lexicographically within the same kind", () => {
  const eff: JsonObject = { z: 1, m: 1, a: 1 };
  const report = diffConfigs(eff, {}, "test");
  assert.deepEqual(report.drifts.map((d) => d.path), ["a", "m", "z"]);
  assert.ok(report.drifts.every((d) => d.kind === "missing_required"));
});

test("nested paths use dot notation", () => {
  const eff: JsonObject = { svc: { api: { timeoutMs: 100 } } };
  const snap = { svc: { api: { timeoutMs: 250 } } };
  const report = diffConfigs(eff, snap, "test");
  assert.equal(report.drifts.length, 1);
  assert.equal(report.drifts[0]!.path, "svc.api.timeoutMs");
  assert.equal(report.drifts[0]!.kind, "value_mismatch");
});

test("no drift yields explicit PASS marker", () => {
  const report = diffConfigs(effective, JSON.parse(JSON.stringify(effective)), "test");
  assert.equal(report.status, "PASS");
  assert.deepEqual(report.drifts, []);
});

test("array content difference is a value_mismatch at the array path", () => {
  const report = diffConfigs({ list: [1, 2] }, { list: [1, 2, 3] }, "test");
  assert.deepEqual(report.drifts.map((d) => [d.kind, d.path]), [["value_mismatch", "list"]]);
});
