// Data contracts exchanged between modules. Everything crossing a module
// boundary (parser -> kernel -> adapter -> HTTP) is one of these types.

/** Static definition of a build target, supplied by the caller. */
export interface TargetDefinition {
  /** Unique target name. */
  name: string;
  /** File paths (relative to the workspace root) this target watches. */
  watchPaths: string[];
  /** Names of other targets this target depends on (build after them). */
  dependencies: string[];
}

/** A batch of file-change events. */
export interface ChangeEvent {
  /** Paths (relative to the workspace root) that changed. */
  paths: string[];
}

/** Runtime state of a target inside the scheduler. */
export type TargetState = "idle" | "queued" | "building";

/** Terminal outcome of a target within one run. */
export type OutcomeStatus = "success" | "failed" | "skipped" | "blocked";

export interface TargetOutcome {
  target: string;
  status: OutcomeStatus;
  /** Why this outcome happened (skip reason, failure message, ...). */
  reason?: string;
  /** For "blocked": name of the failed upstream target. */
  blockedBy?: string;
  /** Aggregate content fingerprint observed for this outcome. */
  fingerprint?: string;
  durationMs: number;
}

/** Full report of one submitted change batch. */
export interface RunReport {
  runId: string;
  changedPaths: string[];
  /** Targets selected for rebuild (direct matches + transitive dependents). */
  affected: string[];
  /** Stable topological build order (lexicographic tie-break). */
  order: string[];
  outcomes: TargetOutcome[];
  startedAt: string;
  finishedAt: string;
}

/** Row persisted in SQLite for each finished target attempt. */
export interface BuildRecord {
  id: number;
  runId: string;
  target: string;
  status: OutcomeStatus;
  reason: string | null;
  blockedBy: string | null;
  fingerprint: string | null;
  durationMs: number;
  at: string;
}

/** Structured log entry; the diagnostic interface and the log file both use it. */
export interface LogEntry {
  at: string;
  runId: string | null;
  target: string | null;
  event: string;
  detail: string;
}
