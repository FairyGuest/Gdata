/** Shared data contracts between modules. */

export interface TargetDefinition {
  name: string;
  /** Watched file paths (relative to workspace root). */
  paths: string[];
  /** Names of targets this target depends on. */
  deps: string[];
}

export interface ChangeEvent {
  /** File paths that changed (relative to workspace root). */
  paths: string[];
}

export type TargetState = 'queued' | 'building' | 'success' | 'failed';

export type BuildOutcome = 'success' | 'failed' | 'skipped' | 'blocked';

export interface BuildRecord {
  runId: number;
  target: string;
  outcome: BuildOutcome;
  /** Reason, e.g. skip reason or the name of the failed upstream. */
  reason: string | null;
  fingerprint: string | null;
  startedAt: string;
  finishedAt: string;
}

export interface TargetStatus {
  name: string;
  state: TargetState | 'idle';
  pendingRebuild: boolean;
  lastOutcome: BuildOutcome | null;
  lastReason: string | null;
  lastFingerprint: string | null;
}

export interface RunResult {
  runId: number;
  changedPaths: string[];
  affected: string[];
  order: string[];
  records: BuildRecord[];
  status: 'running' | 'completed';
}

export interface ServiceConfig {
  /** SQLite file path, or ':memory:'. */
  dbPath: string;
  /** Root directory that watched paths are resolved against. */
  workspaceRoot: string;
  /** Artificial per-target build latency (ms) so tests/demo can interleave events. */
  buildDelayMs: number;
  /** Max targets allowed in one run's rebuild set. */
  maxRebuildSetSize: number;
  /** Max targets registered per service instance. */
  maxTargets: number;
}