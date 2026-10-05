// 数据契约：模块间传递的唯一事实来源。

export type CanonicalStatus = "passed" | "failed" | "skipped";

export interface TestCaseInput {
  file: string;
  name: string;
  status: string;
  durationMs: number;
}

export interface TestRunInput {
  runId: string;
  cases: TestCaseInput[];
}

export interface NormalizedCase {
  file: string;
  name: string;
  status: CanonicalStatus;
  durationMs: number;
}

export interface ReportCase extends NormalizedCase {
  key: string;
}

export interface ReportSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  totalDurationMs: number;
}

export interface Report {
  reportId: string;
  createdAt: string;
  runIds: string[];
  cases: ReportCase[];
  summary: ReportSummary;
}

export type DiffCategory =
  | "new_failure"
  | "persistent_failure"
  | "recovered"
  | "passed"
  | "added"
  | "removed";

export interface DiffEntry {
  key: string;
  file: string;
  name: string;
  category: DiffCategory;
  beforeStatus: CanonicalStatus | null;
  afterStatus: CanonicalStatus | null;
  beforeDurationMs: number | null;
  afterDurationMs: number | null;
}

export interface DiffReport {
  baseReportId: string;
  targetReportId: string;
  entries: DiffEntry[];
  summary: Record<DiffCategory, number>;
}

export interface QueryFilter {
  file?: string;
  name?: string;
  status?: CanonicalStatus;
  minDurationMs?: number;
  maxDurationMs?: number;
  sortBy?: "file" | "name" | "status" | "durationMs";
  order?: "asc" | "desc";
}
