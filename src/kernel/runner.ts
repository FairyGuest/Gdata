import { ServiceError } from '../contract/errors.ts';
import type { RunOutcome, RunRecord, TestExecutor } from '../contract/types.ts';

export interface RunOptions {
  runs: number;
  maxRuns: number;
  logger?: (line: string) => void;
}

// Execution kernel: runs the executor N times and records every run with its
// 1-based index so failures can be replayed. Distinguishes:
//  - INPUT_ERROR: invalid run count
//  - RESOURCE_EXHAUSTED: run count above the configured budget
//  - COMPUTATION_FAILED: executor violated the outcome contract
//  - executor throwing => the TEST failed that run (recorded, not rethrown)
export async function executeRuns(testName: string, executor: TestExecutor, opts: RunOptions): Promise<RunRecord[]> {
  const log = opts.logger ?? (() => {});
  if (!Number.isInteger(opts.runs) || opts.runs < 1) {
    throw new ServiceError('INPUT_ERROR', `runs must be a positive integer, got ${opts.runs}`);
  }
  if (opts.runs > opts.maxRuns) {
    throw new ServiceError('RESOURCE_EXHAUSTED', `requested ${opts.runs} runs exceeds budget of ${opts.maxRuns}`, { requested: opts.runs, maxRuns: opts.maxRuns });
  }
  const records: RunRecord[] = [];
  for (let i = 1; i <= opts.runs; i++) {
    const started = performance.now();
    let outcome: RunOutcome;
    let detail: string | undefined;
    try {
      const raw = await executor(i);
      if (raw !== 'pass' && raw !== 'fail') {
        throw new ServiceError('COMPUTATION_FAILED', `executor for '${testName}' returned invalid outcome ${JSON.stringify(raw)} at run #${i}`);
      }
      outcome = raw;
    } catch (err) {
      if (err instanceof ServiceError) throw err;
      outcome = 'fail';
      detail = err instanceof Error ? err.message : String(err);
    }
    const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
    records.push(detail === undefined ? { runIndex: i, outcome, durationMs } : { runIndex: i, outcome, durationMs, detail });
    log(`[kernel] test=${testName} run=${i}/${opts.runs} outcome=${outcome} durationMs=${durationMs}${detail ? ` detail=${detail}` : ''}`);
  }
  return records;
}
