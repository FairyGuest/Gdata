// Shared data contracts between contract parsing, mutator, kernel, store and API layers.

export type MutationType =
  | 'EqualityOperator'
  | 'ArithmeticOperator'
  | 'ConditionalBoundary'
  | 'BooleanLiteral'
  | 'RemoveCall';

export interface MutationOperator {
  readonly type: MutationType;
  readonly description: string;
  // Ordered [from, to] replacement pairs applied at a single source position.
  readonly replacements: ReadonlyArray<readonly [string, string]>;
}

export interface Mutant {
  readonly id: string;            // deterministic: <file>:<offset>:<type>:<index>
  readonly file: string;          // project-relative source file
  readonly offset: number;        // char offset of the mutated token
  readonly line: number;
  readonly column: number;
  readonly type: MutationType;
  readonly original: string;      // token replaced
  readonly replacement: string;   // token inserted
}

export type MutantStatus = 'killed' | 'survived' | 'timeout' | 'error';

export interface MutantResult {
  readonly mutant: Mutant;
  readonly status: MutantStatus;
  readonly durationMs: number;
  readonly reason: string;        // human-readable judgement rationale
  readonly testExitCode: number | null;
  readonly testOutputTail: string; // last chars of test output for replay
}

export interface RunSummary {
  readonly runId: string;
  readonly projectDir: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly total: number;
  readonly killed: number;
  readonly survived: number;
  readonly timeouts: number;
  readonly errors: number;
  readonly score: number;         // killed / total (timeouts count as killed)
  readonly survivors: ReadonlyArray<Mutant>;
}

export interface RunRequest {
  readonly projectDir: string;
  readonly testCommand?: string;          // default from config
  readonly files?: ReadonlyArray<string>; // restrict mutated files
  readonly types?: ReadonlyArray<MutationType>;
  readonly maxMutants?: number;           // resource guard
  readonly timeoutMs?: number;            // per-mutant test timeout
}

export interface RunRecord extends RunSummary {
  readonly results: ReadonlyArray<MutantResult>;
}

