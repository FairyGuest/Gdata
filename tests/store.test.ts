import { test } from "node:test";
import assert from "node:assert/strict";
import { ReportStore } from "../src/storage/reports.ts";
import { aggregateRuns } from "../src/core/aggregate.ts";
import { AppError } from "../src/diagnostics/errors.ts";

const OPTS = { maxCasesPerReport: 100, maxRunsPerReport: 10 };

test("存储往返：保存后可按 id 读回等价报告", () => {
  const store = new ReportStore(":memory:");
  const r = aggregateRuns(
    [{ runId: "run-1", cases: [{ file: "a", name: "t", status: "passed", durationMs: 3 }] }],
    "rep-1",
    OPTS,
  );
  store.save(r);
  const back = store.get("rep-1");
  assert.deepEqual(back, r);
  assert.deepEqual(store.list(), [{ reportId: "rep-1", createdAt: r.createdAt }]);
  store.close();
});

test("读取不存在的报告：NOT_FOUND", () => {
  const store = new ReportStore(":memory:");
  assert.throws(
    () => store.get("nope"),
    (e: unknown) => e instanceof AppError && (e as AppError).code === "NOT_FOUND",
  );
  store.close();
});

