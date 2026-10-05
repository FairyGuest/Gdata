import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateRuns, filterAndSort } from "../src/core/aggregate.ts";
import { parseRunsPayload } from "../src/contracts/parse.ts";
import { AppError } from "../src/diagnostics/errors.ts";
import type { TestRunInput } from "../src/contracts/types.ts";

const OPTS = { maxCasesPerReport: 100, maxRunsPerReport: 10 };

test("纯通过：全部用例聚合为 passed", () => {
  const runs: TestRunInput[] = [
    {
      runId: "run-pass-1",
      cases: [
        { file: "a.spec.ts", name: "t1", status: "passed", durationMs: 10 },
        { file: "a.spec.ts", name: "t2", status: "ok", durationMs: 20 },
        { file: "b.spec.ts", name: "t3", status: "PASS", durationMs: 30 },
      ],
    },
  ];
  const r = aggregateRuns(runs, "r-pass", OPTS);
  assert.deepEqual(r.summary, { total: 3, passed: 3, failed: 0, skipped: 0, totalDurationMs: 60 });
  assert.equal(r.cases.every((c) => c.status === "passed"), true);
});

test("纯失败：全部用例聚合为 failed", () => {
  const runs: TestRunInput[] = [
    {
      runId: "run-fail-1",
      cases: [
        { file: "a.spec.ts", name: "t1", status: "failed", durationMs: 5 },
        { file: "b.spec.ts", name: "t2", status: "error", durationMs: 7 },
      ],
    },
  ];
  const r = aggregateRuns(runs, "r-fail", OPTS);
  assert.deepEqual(r.summary, { total: 2, passed: 0, failed: 2, skipped: 0, totalDurationMs: 12 });
});

test("混合状态：状态别名归一化 + 汇总计数精确", () => {
  const runs: TestRunInput[] = [
    {
      runId: "run-mix-1",
      cases: [
        { file: "a.spec.ts", name: "t1", status: "passed", durationMs: 10 },
        { file: "a.spec.ts", name: "t2", status: "failure", durationMs: 20 },
        { file: "b.spec.ts", name: "t3", status: "pending", durationMs: 0 },
        { file: "b.spec.ts", name: "t4", status: "skipped", durationMs: 1 },
      ],
    },
    {
      runId: "run-mix-2",
      cases: [{ file: "c.spec.ts", name: "t5", status: "broken", durationMs: 99 }],
    },
  ];
  const r = aggregateRuns(runs, "r-mix", OPTS);
  assert.deepEqual(r.summary, { total: 5, passed: 1, failed: 2, skipped: 2, totalDurationMs: 130 });
  assert.deepEqual(r.runIds, ["run-mix-1", "run-mix-2"]);
});

test("跨运行状态冲突：抛 STATUS_CONFLICT 且带冲突上下文", () => {
  const runs: TestRunInput[] = [
    { runId: "r1", cases: [{ file: "a", name: "t", status: "passed", durationMs: 1 }] },
    { runId: "r2", cases: [{ file: "a", name: "t", status: "failed", durationMs: 1 }] },
  ];
  assert.throws(
    () => aggregateRuns(runs, "r-conflict", OPTS),
    (e: unknown) => {
      assert.ok(e instanceof AppError);
      assert.equal((e as AppError).code, "STATUS_CONFLICT");
      assert.equal((e as AppError).httpStatus, 409);
      return true;
    },
  );
});

test("同状态重复用例：幂等去重不冲突", () => {
  const runs: TestRunInput[] = [
    { runId: "r1", cases: [{ file: "a", name: "t", status: "passed", durationMs: 1 }] },
    { runId: "r2", cases: [{ file: "a", name: "t", status: "ok", durationMs: 1 }] },
  ];
  const r = aggregateRuns(runs, "r-dup", OPTS);
  assert.equal(r.summary.total, 1);
});

test("未知状态：抛 UNKNOWN_STATUS，绝不静默成功", () => {
  const runs: TestRunInput[] = [
    { runId: "r1", cases: [{ file: "a", name: "t", status: "maybe", durationMs: 1 }] },
  ];
  assert.throws(
    () => aggregateRuns(runs, "r-unknown", OPTS),
    (e: unknown) => e instanceof AppError && (e as AppError).code === "UNKNOWN_STATUS",
  );
});

test("非法输入：抛 INPUT_ERROR", () => {
  assert.throws(() => parseRunsPayload({ runs: [] }), /runs must not be empty/);
  assert.throws(
    () => parseRunsPayload({ runs: [{ runId: "x", cases: [{ file: "a", name: "t", status: "passed", durationMs: -1 }] }] }),
    (e: unknown) => e instanceof AppError && (e as AppError).code === "INPUT_ERROR",
  );
  assert.throws(
    () => parseRunsPayload({ runs: [{ cases: [] }] }),
    (e: unknown) => e instanceof AppError && (e as AppError).code === "INPUT_ERROR",
  );
});

test("资源耗尽：超出用例上限抛 RESOURCE_EXHAUSTED", () => {
  const runs: TestRunInput[] = [
    {
      runId: "big",
      cases: Array.from({ length: 5 }, (_, i) => ({ file: "f", name: "t" + i, status: "passed", durationMs: 1 })),
    },
  ];
  assert.throws(
    () => aggregateRuns(runs, "r-big", { maxCasesPerReport: 3, maxRunsPerReport: 10 }),
    (e: unknown) => e instanceof AppError && (e as AppError).code === "RESOURCE_EXHAUSTED",
  );
});

test("过滤与排序：按文件/状态/耗时过滤，按耗时降序", () => {
  const runs: TestRunInput[] = [
    {
      runId: "r1",
      cases: [
        { file: "a.spec.ts", name: "fast", status: "passed", durationMs: 5 },
        { file: "a.spec.ts", name: "slow", status: "failed", durationMs: 500 },
        { file: "b.spec.ts", name: "mid", status: "passed", durationMs: 50 },
      ],
    },
  ];
  const r = aggregateRuns(runs, "r-filter", OPTS);
  const failed = filterAndSort(r.cases, { status: "failed" });
  assert.deepEqual(failed.map((c) => c.name), ["slow"]);
  const sorted = filterAndSort(r.cases, { sortBy: "durationMs", order: "desc" });
  assert.deepEqual(sorted.map((c) => c.durationMs), [500, 50, 5]);
  const ranged = filterAndSort(r.cases, { minDurationMs: 10, maxDurationMs: 100 });
  assert.deepEqual(ranged.map((c) => c.name), ["mid"]);
  const byFile = filterAndSort(r.cases, { file: "b.spec" });
  assert.deepEqual(byFile.map((c) => c.name), ["mid"]);
});

