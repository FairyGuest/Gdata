import test from "node:test";
import assert from "node:assert/strict";
import { toCaseResult, adaptAll } from "../src/status/adapter.ts";

test("ok outcome maps to passed", () => {
  const r = toCaseResult("f.test.js", "c", { kind: "ok", durationMs: 12 });
  assert.equal(r.status, "passed");
  assert.equal(r.durationMs, 12);
  assert.equal(r.error, undefined);
  assert.equal(r.caseId, "f.test.js#c");
});

test("error outcome maps to failed with error details", () => {
  const r = toCaseResult("f.test.js", "c", {
    kind: "error",
    durationMs: 3,
    error: { name: "AssertionError", message: "boom" },
  });
  assert.equal(r.status, "failed");
  assert.equal(r.error!.name, "AssertionError");
  assert.equal(r.error!.message, "boom");
});

test("timeout outcome maps to timeout with actual duration", () => {
  const r = toCaseResult("f.test.js", "c", { kind: "timeout", durationMs: 505, timeoutMs: 500 });
  assert.equal(r.status, "timeout");
  assert.equal(r.durationMs, 505);
  assert.match(r.error!.message, /500ms/);
});

test("worker crash maps to failed, never to success", () => {
  const r = toCaseResult("f.test.js", "c", {
    kind: "worker-crash",
    durationMs: 1,
    error: { name: "WorkerExit", message: "worker exited with code 1" },
  });
  assert.equal(r.status, "failed");
  assert.match(r.error!.message, /worker crashed/);
});

test("missing outcome maps to failed, never silently passed", () => {
  const results = adaptAll([{ relPath: "x.test.js", cases: ["c1"] }], new Map());
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "failed");
});
