// 执行内核 - 聚合：合并多个测试运行为一份报告。

import type { Report, ReportCase, TestRunInput, QueryFilter } from "../contracts/types.ts";
import { normalizeStatus } from "../adapters/status.ts";
import { statusConflict, resourceExhausted } from "../diagnostics/errors.ts";
import type { Logger } from "../diagnostics/logger.ts";

export interface AggregateOptions {
  maxCasesPerReport: number;
  maxRunsPerReport: number;
  logger?: Logger;
}

export function caseKey(file: string, name: string): string {
  return file + "\0" + name;
}

export function aggregateRuns(
  runs: TestRunInput[],
  reportId: string,
  opts: AggregateOptions,
): Report {
  const log = opts.logger;
  if (runs.length > opts.maxRunsPerReport) {
    throw resourceExhausted("too many runs in one report", {
      got: runs.length,
      max: opts.maxRunsPerReport,
    });
  }
  const totalCases = runs.reduce((n, r) => n + r.cases.length, 0);
  if (totalCases > opts.maxCasesPerReport) {
    throw resourceExhausted("too many cases in one report", {
      got: totalCases,
      max: opts.maxCasesPerReport,
    });
  }

  const byKey = new Map<string, ReportCase>();
  const origin = new Map<string, string>(); // key -> 首次出现的 runId
  for (const run of runs) {
    for (const c of run.cases) {
      const status = normalizeStatus(c.status, `run=${run.runId} case=${c.file}#${c.name}`);
      const key = caseKey(c.file, c.name);
      const prev = byKey.get(key);
      if (prev) {
        if (prev.status !== status) {
          log?.log({
            level: "error",
            event: "status_conflict",
            runId: run.runId,
            reportId,
            state: { key: c.file + "#" + c.name, first: prev.status, now: status, firstRunId: origin.get(key) },
            reason: "same test case reported with conflicting statuses across runs",
          });
          throw statusConflict(`conflicting status for ${c.file}#${c.name}`, {
            key: c.file + "#" + c.name,
            firstRunId: origin.get(key),
            firstStatus: prev.status,
            conflictRunId: run.runId,
            conflictStatus: status,
          });
        }
        continue; // 状态一致的重复用例：幂等去重
      }
      byKey.set(key, { key, file: c.file, name: c.name, status, durationMs: c.durationMs });
      origin.set(key, run.runId);
    }
  }

  const cases = [...byKey.values()];
  const summary = {
    total: cases.length,
    passed: cases.filter((c) => c.status === "passed").length,
    failed: cases.filter((c) => c.status === "failed").length,
    skipped: cases.filter((c) => c.status === "skipped").length,
    totalDurationMs: cases.reduce((n, c) => n + c.durationMs, 0),
  };
  log?.log({
    level: "info",
    event: "aggregate_done",
    reportId,
    state: { runIds: runs.map((r) => r.runId), summary },
    reason: "runs merged; duplicate keys with identical status deduplicated",
  });
  return {
    reportId,
    createdAt: new Date().toISOString(),
    runIds: runs.map((r) => r.runId),
    cases,
    summary,
  };
}

export function filterAndSort(cases: ReportCase[], q: QueryFilter): ReportCase[] {
  let out = cases;
  if (q.file !== undefined) out = out.filter((c) => c.file.includes(q.file!));
  if (q.name !== undefined) out = out.filter((c) => c.name.includes(q.name!));
  if (q.status !== undefined) out = out.filter((c) => c.status === q.status);
  if (q.minDurationMs !== undefined) out = out.filter((c) => c.durationMs >= q.minDurationMs!);
  if (q.maxDurationMs !== undefined) out = out.filter((c) => c.durationMs <= q.maxDurationMs!);
  if (q.sortBy) {
    const dir = q.order === "desc" ? -1 : 1;
    const key = q.sortBy;
    out = out.slice().sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }
  return out;
}
