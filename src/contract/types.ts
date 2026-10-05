export type RunOutcome = 'pass' | 'fail';

export interface RunRecord {
  runIndex: number; // 1-based
  outcome: RunOutcome;
  durationMs: number;
  detail?: string;
}

export type Classification = 'stable_pass' | 'stable_fail' | 'flaky';

export interface PassFailDistribution {
  passes: number;
  failures: number;
}

export interface DetectionReport {
  testName: string;
  roundId: string;
  totalRuns: number;
  classification: Classification;
  confidence: number; // 0..1, rounded to 4 decimals
  distribution: PassFailDistribution | null; // only for flaky
  firstFailureRun: number | null; // 1-based run index of first failure, flaky only
  suggestedRetries: number;
  reasoning: string;
  createdAt: string;
}

export interface TrendEntry {
  roundId: string;
  createdAt: string;
  classification: Classification;
  confidence: number;
  totalRuns: number;
  passes: number;
  failures: number;
}

// Executor contract: given a 1-based run index, return the outcome of that run.
// Throwing means the test itself failed (recorded as 'fail' with detail).
// Returning anything other than 'pass'/'fail' violates the contract and is a
// COMPUTATION_FAILED error in the kernel.
export type TestExecutor = (runIndex: number) => Promise<RunOutcome> | RunOutcome;
