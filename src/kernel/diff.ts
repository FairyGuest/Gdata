import type { DiffCategory, DiffEntry, Report, ReportDiff, TestCase } from '../contract/types.js';

const CATEGORIES: DiffCategory[] = [
  'new_failure', 'persistent_failure', 'recovered', 'passed', 'skipped', 'removed',
];

function categorize(current: TestCase | undefined, previous: TestCase | undefined): DiffCategory {
  if (!current) return 'removed';
  if (current.status === 'skipped') return 'skipped';
  if (current.status === 'failed') {
    return previous?.status === 'failed' ? 'persistent_failure' : 'new_failure';
  }
  return previous?.status === 'failed' ? 'recovered' : 'passed';
}

/** Diffs head against base; entries are ordered new_failure > persistent_failure > recovered > passed > skipped > removed. */
export function diffReports(base: Report, head: Report): ReportDiff {
  const baseByKey = new Map(base.cases.map((testCase) => [testCase.key, testCase]));
  const headByKey = new Map(head.cases.map((testCase) => [testCase.key, testCase]));
  const entries: DiffEntry[] = [];
  const counts = Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<DiffCategory, number>;
  const push = (key: string, current: TestCase | undefined, previous: TestCase | undefined) => {
    const source = current ?? previous;
    if (!source) return;
    const category = categorize(current, previous);
    counts[category] += 1;
    entries.push({
      key,
      file: source.file,
      name: source.name,
      category,
      previousStatus: previous?.status ?? null,
      currentStatus: current?.status ?? null,
      durationMs: current?.durationMs ?? null,
    });
  };
  for (const [key, current] of headByKey) push(key, current, baseByKey.get(key));
  for (const [key, previous] of baseByKey) {
    if (!headByKey.has(key)) push(key, undefined, previous);
  }
  entries.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
  return { baseReportId: base.id, headReportId: head.id, counts, entries };
}
