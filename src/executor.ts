import { execFile } from 'node:child_process';
import { AppError } from './errors.ts';
import type { RunRequest, TestOutcome, TestSpec } from './contract.ts';

export interface RunLogEntry {
  runIndex: number;
  testName: string;
  outcome: TestOutcome;
  reason: string;
}

export interface ExecutionResult {
  outcomesByTest: Map<string, TestOutcome[]>;
  log: RunLogEntry[];
}

export interface ExecutorOptions {
  cmdTimeoutMs: number;
}

export const DEFAULT_EXECUTOR_OPTIONS: ExecutorOptions = { cmdTimeoutMs: 30_000 };

export async function executeSuite(
  request: RunRequest,
  options: ExecutorOptions = DEFAULT_EXECUTOR_OPTIONS,
): Promise<ExecutionResult> {
  const outcomesByTest = new Map<string, TestOutcome[]>();
  const log: RunLogEntry[] = [];
  for (const t of request.tests) outcomesByTest.set(t.name, []);

  for (let runIndex = 1; runIndex <= request.runs; runIndex++) {
    for (const spec of request.tests) {
      const { outcome, reason } = await runOnce(spec, runIndex, options);
      outcomesByTest.get(spec.name)!.push(outcome);
      log.push({ runIndex, testName: spec.name, outcome, reason });
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { outcomesByTest, log };
}

async function runOnce(
  spec: TestSpec,
  runIndex: number,
  options: ExecutorOptions,
): Promise<{ outcome: TestOutcome; reason: string }> {
  if (spec.kind === 'scripted') {
    const outcome = spec.outcomes[(runIndex - 1) % spec.outcomes.length];
    return {
      outcome,
      reason: 'scripted pattern [' + spec.outcomes.join(',') + '] at position ' +
        (((runIndex - 1) % spec.outcomes.length) + 1) + ' -> ' + outcome,
    };
  }
  return runCommand(spec.command, options.cmdTimeoutMs);
}

function runCommand(command: string, timeoutMs: number): Promise<{ outcome: TestOutcome; reason: string }> {
  return new Promise((resolve, reject) => {
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? ['/c', command] : ['-c', command];
    let settled = false;
    const failComputation = (message: string, detail?: unknown) => {
      if (!settled) {
        settled = true;
        reject(new AppError('COMPUTATION_FAILED', message, detail));
      }
    };
    try {
      execFile(shell, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (settled) return;
        if (err === null) {
          settled = true;
          resolve({ outcome: 'pass', reason: 'exit code 0' });
          return;
        }
        const anyErr = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
        if (anyErr.killed) {
          failComputation('test command timed out after ' + timeoutMs + 'ms: ' + command);
          return;
        }
        if (typeof anyErr.code === 'string') {
          failComputation('failed to spawn test command: ' + command, {
            errno: anyErr.code,
            stderr: String(stderr).slice(0, 500),
          });
          return;
        }
        settled = true;
        resolve({
          outcome: 'fail',
          reason: 'exit code ' + String(anyErr.code) + (stderr ? '; stderr: ' + String(stderr).slice(0, 200) : ''),
        });
      });
    } catch (err) {
      failComputation('failed to spawn test command: ' + command, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
