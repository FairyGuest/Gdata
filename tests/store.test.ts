import test from "node:test";
import assert from "node:assert/strict";
import { ResultStore } from "../src/store/db.ts";
import type { RunSummary } from "../src/contract/types.ts";

const sample = (runId: string, startedAt: string): RunSummary => ({
  runId,
  dir: "demo",
  pattern: "**/*.test.js",
  startedAt,
  finishedAt: startedAt,
  durationMs: 10,
  total: 2,
  passed: 1,
  failed: 1,
  timeout: 0,
  results: [
    { caseId: "a.test.js#x", file: "a.test.js", caseName: "x", status: "passed", durationMs: 4 },
    { caseId: "b.test.js#y", file: "b.test.js", caseName: "y", status: "failed", durationMs: 6,
      error: { name: "AssertionError", message: "nope" } },
  ],
});

test("store saves and retrieves runs, queries by file and time", () => {
  const store = new ResultStore(":memory:");
  store.saveRun(sample("run-1", "2026-10-01T10:00:00.000Z"));
  store.saveRun(sample("run-2", "2026-10-02T10:00:00.000Z"));

  const one = store.getRun("run-1");
  assert.ok(one);
  assert.equal(one.total, 2);
  assert.equal(one.results[1].status, "failed");
  assert.equal(one.results[1].error!.message, "nope");
  assert.equal(store.getRun("missing"), null);

  const byFile = store.queryRuns({ file: "b.test.js" });
  assert.equal(byFile.length, 2);
  const none = store.queryRuns({ file: "zzz.test.js" });
  assert.equal(none.length, 0);

  const byTime = store.queryRuns({ from: "2026-10-02T00:00:00.000Z" });
  assert.deepEqual(byTime.map((r) => r.runId), ["run-2"]);
  store.close();
});
