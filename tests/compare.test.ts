import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateRuns } from "../src/core/aggregate.ts";
import { compareReports } from "../src/core/compare.ts";
import type { TestRunInput } from "../src/contracts/types.ts";

const OPTS = { maxCasesPerReport: 100, maxRunsPerReport: 10 };

function report(id: string, cases: Array<[string, string, string, number]>) {
  const runs: TestRunInput[] = [
    { runId: id + "-run", cases: cases.map(([file, name, status, durationMs]) => ({ file, name, status, durationMs })) },
  ];
  return aggregateRuns(runs, id, OPTS);
}

// 基线：new-fail 候选(通过)、persistent(失败)、recovered 候选(失败)、stable(通过)、removed(通过)
const base = report("base", [
  ["f.ts", "becomes-bad", "passed", 10],
  ["f.ts", "still-bad", "failed", 20],
  ["f.ts", "now-good", "failed", 30],
  ["f.ts", "stable", "passed", 40],
  ["f.ts", "gone", "passed", 50],
]);

const target = report("target", [
  ["f.ts", "becomes-bad", "failed", 11],
  ["f.ts", "still-bad", "failed", 21],
  ["f.ts", "now-good", "passed", 31],
  ["f.ts", "stable", "passed", 41],
  ["f.ts", "brand-new", "passed", 60],
]);

test("对比分类：新失败/持续失败/恢复/通过/新增/移除", () => {
  const diff = compareReports(base, target);
  const byName = new Map(diff.entries.map((e) => [e.name, e]));
  assert.equal(byName.get("becomes-bad")!.category, "new_failure");
  assert.equal(byName.get("still-bad")!.category, "persistent_failure");
  assert.equal(byName.get("now-good")!.category, "recovered");
  assert.equal(byName.get("stable")!.category, "passed");
  assert.equal(byName.get("brand-new")!.category, "added");
  assert.equal(byName.get("gone")!.category, "removed");
  assert.deepEqual(diff.summary, {
    new_failure: 1,
    persistent_failure: 1,
    recovered: 1,
    passed: 1,
    added: 1,
    removed: 1,
  });
});

test("对比排序：新失败 > 持续失败 > 恢复 > 通过 > 新增 > 移除", () => {
  const diff = compareReports(base, target);
  assert.deepEqual(
    diff.entries.map((e) => e.name),
    ["becomes-bad", "still-bad", "now-good", "stable", "brand-new", "gone"],
  );
});

test("前后状态与耗时记录正确", () => {
  const diff = compareReports(base, target);
  const e = diff.entries.find((x) => x.name === "becomes-bad")!;
  assert.equal(e.beforeStatus, "passed");
  assert.equal(e.afterStatus, "failed");
  assert.equal(e.beforeDurationMs, 10);
  assert.equal(e.afterDurationMs, 11);
  const gone = diff.entries.find((x) => x.name === "gone")!;
  assert.equal(gone.afterStatus, null);
});

test("跳过->失败 属于新失败；失败->跳过 不算恢复", () => {
  const b = report("b2", [["f", "a", "skipped", 1], ["f", "b", "failed", 1]]);
  const t = report("t2", [["f", "a", "failed", 1], ["f", "b", "skipped", 1]]);
  const diff = compareReports(b, t);
  const byName = new Map(diff.entries.map((e) => [e.name, e]));
  assert.equal(byName.get("a")!.category, "new_failure");
  assert.equal(byName.get("b")!.category, "passed");
});

