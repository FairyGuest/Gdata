// 执行内核 - 对比：两次报告差异分类与排序。

import type { DiffCategory, DiffEntry, DiffReport, Report } from "../contracts/types.ts";
import type { Logger } from "../diagnostics/logger.ts";

const ORDER: DiffCategory[] = [
  "new_failure",
  "persistent_failure",
  "recovered",
  "passed",
  "added",
  "removed",
];

function classify(
  before: string | null,
  after: string | null,
): DiffCategory {
  if (before === null) return "added";
  if (after === null) return "removed";
  if (before === "failed" && after === "passed") return "recovered";
  if (before !== "failed" && after === "failed") return "new_failure";
  if (before === "failed" && after === "failed") return "persistent_failure";
  return "passed";
}

export function compareReports(base: Report, target: Report, logger?: Logger): DiffReport {
  const beforeMap = new Map(base.cases.map((c) => [c.key, c]));
  const afterMap = new Map(target.cases.map((c) => [c.key, c]));
  const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const entries: DiffEntry[] = [];
  for (const key of keys) {
    const b = beforeMap.get(key) ?? null;
    const a = afterMap.get(key) ?? null;
    const ref = a ?? b!;
    const category = classify(b?.status ?? null, a?.status ?? null);
    entries.push({
      key,
      file: ref.file,
      name: ref.name,
      category,
      beforeStatus: b?.status ?? null,
      afterStatus: a?.status ?? null,
      beforeDurationMs: b?.durationMs ?? null,
      afterDurationMs: a?.durationMs ?? null,
    });
    if (category !== "passed") {
      logger?.log({
        level: "info",
        event: "diff_entry",
        reportId: target.reportId,
        state: { key: ref.file + "#" + ref.name, before: b?.status ?? null, after: a?.status ?? null },
        reason: `classified as ${category}`,
      });
    }
  }
  entries.sort(
    (x, y) => ORDER.indexOf(x.category) - ORDER.indexOf(y.category) || x.key.localeCompare(y.key),
  );
  const summary: Record<DiffCategory, number> = {
    new_failure: 0,
    persistent_failure: 0,
    recovered: 0,
    passed: 0,
    added: 0,
    removed: 0,
  };
  for (const e of entries) summary[e.category]++;
  logger?.log({
    level: "info",
    event: "diff_done",
    reportId: target.reportId,
    state: { base: base.reportId, target: target.reportId, summary },
    reason: "ordered new_failure > persistent_failure > recovered > passed > added > removed",
  });
  return { baseReportId: base.reportId, targetReportId: target.reportId, entries, summary };
}
