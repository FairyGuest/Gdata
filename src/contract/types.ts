/** Shared data contracts between parser, kernel, adapter, store and server. */

export type CaseStatus = "passed" | "failed" | "timeout";

export interface CaseError {
  name: string;
  message: string;
  stack?: string;
}

export interface CaseResult {
  /** Stable id: "<relativeFile>#<caseName>" */
  caseId: string;
  file: string;
  caseName: string;
  status: CaseStatus;
  /** Wall-clock duration of the case, in milliseconds. */
  durationMs: number;
  error?: CaseError;
}

export interface RunSummary {
  runId: string;
  dir: string;
  pattern: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  timeout: number;
  results: CaseResult[];
}

/** A test file discovered on disk, before execution. */
export interface DiscoveredFile {
  /** Absolute path on disk. */
  absPath: string;
  /** Path relative to the scanned directory; used as the public file id. */
  relPath: string;
  /** Case names exported by the file's "tests" export. */
  cases: string[];
  /** relPaths of files that must finish before this file starts. */
  dependsOn: string[];
}

/** Raw outcome reported by the execution kernel for a single case. */
export type RawCaseOutcome =
  | { kind: "ok"; durationMs: number }
  | { kind: "error"; durationMs: number; error: CaseError }
  | { kind: "timeout"; durationMs: number; timeoutMs: number }
  | { kind: "worker-crash"; durationMs: number; error: CaseError };

/** Structured log event emitted by the kernel; enough to replay a run. */
export interface RunEvent {
  ts: string;
  runId: string;
  caseId?: string;
  event:
    | "run-started"
    | "case-scheduled"
    | "case-running"
    | "case-finished"
    | "case-timeout"
    | "case-worker-crash"
    | "run-finished";
  /** Human-readable justification for the transition. */
  reason: string;
}
