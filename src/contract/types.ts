export type TestStatus = 'passed' | 'failed' | 'skipped';

/** Raw case as accepted by the ingestion contract (status not yet normalized). */
export interface RawTestCase {
  file: string;
  name: string;
  status: string;
  durationMs: number;
}

export interface RawTestRun {
  runId: string;
  cases: RawTestCase[];
}

export interface IngestRequest {
  label?: string;
  runs: RawTestRun[];
}

/** Normalized case stored inside a report. */
export interface TestCase {
  key: string;
  file: string;
  name: string;
  status: TestStatus;
  durationMs: number;
  runId: string;
}

export interface ReportSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  totalDurationMs: number;
}

export interface Report {
  id: number;
  label: string | null;
  createdAt: string;
  summary: ReportSummary;
  cases: TestCase[];
}

export type DiffCategory =
  | 'new_failure'
  | 'persistent_failure'
  | 'recovered'
  | 'passed'
  | 'skipped'
  | 'removed';

export interface DiffEntry {
  key: string;
  file: string;
  name: string;
  category: DiffCategory;
  previousStatus: TestStatus | null;
  currentStatus: TestStatus | null;
  durationMs: number | null;
}

export interface ReportDiff {
  baseReportId: number;
  headReportId: number;
  counts: Record<DiffCategory, number>;
  entries: DiffEntry[];
}
