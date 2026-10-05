import { ResourceExhaustedError, StateConflictError } from '../errors.js';
import type { ReportSummary, TestCase } from '../contract/types.js';

export interface AggregateLimits {
  maxCasesPerRun: number;
  maxTotalCases: number;
}

/**
 * Merges normalized cases into a deduplicated set keyed by file::name.
 * Two runs disagreeing about a test's status is a 409 conflict; agreeing
 * duplicates collapse into the latest occurrence.
 */
export function mergeCases(cases: TestCase[], limits: AggregateLimits): TestCase[] {
  const perRun = new Map<string, number>();
  for (const testCase of cases) {
    perRun.set(testCase.runId, (perRun.get(testCase.runId) ?? 0) + 1);
  }
  for (const [runId, count] of perRun) {
    if (count > limits.maxCasesPerRun) {
      throw new ResourceExhaustedError(
        'run ' + runId + ' has ' + count + ' cases, limit is ' + limits.maxCasesPerRun,
        { runId, count, limit: limits.maxCasesPerRun },
      );
    }
  }
  if (cases.length > limits.maxTotalCases) {
    throw new ResourceExhaustedError(
      'ingestion has ' + cases.length + ' cases, limit is ' + limits.maxTotalCases,
      { count: cases.length, limit: limits.maxTotalCases },
    );
  }
  const merged = new Map<string, TestCase>();
  for (const testCase of cases) {
    const existing = merged.get(testCase.key);
    if (existing && existing.status !== testCase.status) {
      throw new StateConflictError(
        'conflicting statuses for ' + testCase.key + ': ' + existing.status +
          ' (run ' + existing.runId + ') vs ' + testCase.status + ' (run ' + testCase.runId + ')',
        { key: testCase.key, statuses: [existing.status, testCase.status] },
      );
    }
    merged.set(testCase.key, testCase);
  }
  return [...merged.values()];
}

export function summarize(cases: TestCase[]): ReportSummary {
  const summary: ReportSummary = { total: 0, passed: 0, failed: 0, skipped: 0, totalDurationMs: 0 };
  for (const testCase of cases) {
    summary.total += 1;
    summary[testCase.status] += 1;
    summary.totalDurationMs += testCase.durationMs;
  }
  return summary;
}
