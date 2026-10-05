// Data and error contracts shared across all modules.

export type MutatorType = 'EqualityFlip' | 'ArithmeticFlip' | 'CallRemoval';

export type MutantStatus = 'killed' | 'survived' | 'timeout' | 'error';

export type RunStatus = 'completed' | 'baseline_failed';

export type ErrorCategory =
  | 'INPUT_ERROR'
  | 'STATE_CONFLICT'
  | 'RESOURCE_EXHAUSTED'
  | 'EXECUTION_FAILED';

export interface MutantSpec {
  id: string;
  mutator: MutatorType;
  file: string;
  offset: number;
  length: number;
  replacement: string;
  original: string;
  preview: string;
}

export interface MutantOutcome extends MutantSpec {
  status: MutantStatus;
  reason: string;
  durationMs: number;
}

export interface RunRequest {
  projectDir: string;
  sourceFile: string;
  testCommand?: string;
  timeoutMs?: number;
  mutators?: MutatorType[];
}

export interface RunReport {
  runId: string;
  status: RunStatus;
  projectDir: string;
  sourceFile: string;
  testCommand: string;
  score: number;
  total: number;
  killed: number;
  survived: number;
  timeout: number;
  error: number;
  survivors: MutantOutcome[];
  mutants: MutantOutcome[];
  log: string[];
  startedAt: string;
  durationMs: number;
}

export interface ApiError {
  error: {
    category: ErrorCategory;
    message: string;
  };
}

export interface MutantQuery {
  file?: string;
  mutator?: MutatorType;
  runId?: string;
}

export interface StoredMutantRow {
  run_id: string;
  mutant_id: string;
  mutator: MutatorType;
  file: string;
  source_offset: number;
  status: MutantStatus;
  reason: string;
}
