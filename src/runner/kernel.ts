// Execution kernel: for each mutant, copy the project to an isolated temp
// workspace, apply the mutant, run the test suite, classify the outcome, and
// discard the workspace (original code is never touched).
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { run as runNodeTests } from 'node:test';
import type { Mutant, MutantResult, MutantStatus } from '../contract/types.ts';
import { ServiceError } from '../contract/errors.ts';
import { applyMutant } from '../mutator/apply.ts';

const execFileAsync = promisify(execFile);

export type ExecutorKind = 'spawn' | 'inprocess';

export interface KernelOptions {
  readonly testCommand: string;
  readonly timeoutMs: number;
  readonly outputTailChars: number;
  readonly executor: ExecutorKind;
  readonly logger?: (msg: string) => void;
}

function listSourceFiles(dir: string, base: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full, base));
    } else if (/\.(js|mjs|cjs|ts)$/.test(entry) && !/\.test\.[a-z]+$/.test(entry)) {
      out.push(relative(base, full).split(sep).join('/'));
    }
  }
  return out;
}

export function collectSourceFiles(projectDir: string): string[] {
  const srcDir = join(projectDir, 'src');
  const root = resolve(projectDir);
  const start = statSync(srcDir, { throwIfNoEntry: false })?.isDirectory() ? srcDir : root;
  return listSourceFiles(start, root).sort();
}

function collectTestFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.test\.(js|mjs|cjs|ts)$/.test(entry)) out.push(full);
    }
  };
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) walk(dir);
  return out.sort();
}

interface TestOutcome {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly output: string;
}

async function runTestsSpawn(workDir: string, cmd: string, timeoutMs: number): Promise<TestOutcome> {
  const parts = cmd.split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new ServiceError('INPUT_INVALID', 'Empty test command');
  try {
    const res = await execFileAsync(parts[0], parts.slice(1), {
      cwd: workDir,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      env: { ...process.env, CI: '1' },
    });
    return { exitCode: res.code ?? 0, timedOut: false, output: String(res.stdout) + String(res.stderr) };
  } catch (err: any) {
    if (err && (err.killed || err.signal === 'SIGTERM') && err.code !== 'ENOENT') {
      return {
        exitCode: null,
        timedOut: true,
        output: String(err.stdout ?? '') + String(err.stderr ?? ''),
      };
    }
    if (err && typeof err.code === 'number') {
      return {
        exitCode: err.code,
        timedOut: false,
        output: String(err.stdout ?? '') + String(err.stderr ?? ''),
      };
    }
    if (err && err.code === 'ENOENT') {
      throw new ServiceError('EXECUTION_FAILED', 'Test command not found: ' + parts[0], { cmd });
    }
    if (err && err.code === 'EPERM') {
      throw new ServiceError('EXECUTION_FAILED',
        'Spawning test processes is not permitted in this environment; ' +
        'set MTS_EXECUTOR=inprocess to run test suites in-process', { cmd });
    }
    throw new ServiceError('EXECUTION_FAILED', 'Failed to spawn test command: ' + String(err), { cmd });
  }
}

// In-process executor: runs *.test.* files under <workDir>/test with the
// node:test API (isolation: none). Used where child processes are blocked.
// Note: with isolation 'none' the run() stream never emits 'end', so
// completion is detected by counting enqueued vs settled tests.
async function runTestsInProcess(workDir: string, timeoutMs: number): Promise<TestOutcome> {
  const files = collectTestFiles(join(workDir, 'test'));
  if (files.length === 0) {
    throw new ServiceError('INPUT_INVALID', 'No test files found under ' + join(workDir, 'test'));
  }
  let enqueued = 0;
  let settled = 0;
  let fail = 0;
  const lines: string[] = [];
  const stream = runNodeTests({ files, isolation: 'none' });
  return new Promise<TestOutcome>((resolvePromise) => {
    let done = false;
    const finish = (outcome: TestOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(overallTimer);
      clearTimeout(idleTimer);
      resolvePromise(outcome);
    };
    const maybeDone = () => {
      if (enqueued > 0 && settled >= enqueued) {
        finish({ exitCode: fail === 0 ? 0 : 1, timedOut: false, output: lines.join('\n') });
      }
    };
    let idleTimer: NodeJS.Timeout;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish({ exitCode: fail === 0 ? 0 : 1, timedOut: false, output: lines.join('\n') });
      }, 1500);
    };
    const overallTimer = setTimeout(() => {
      finish({ exitCode: null, timedOut: true, output: lines.join('\n') });
    }, timeoutMs);
    idleTimer = setTimeout(() => {}, 0);
    clearTimeout(idleTimer);

    (async () => {
      try {
        for await (const event of stream) {
          if (done) break;
          if (event.type === 'test:enqueue') {
            enqueued++;
          } else if (event.type === 'test:pass') {
            settled++;
            lines.push('ok ' + event.data.name);
            armIdle();
            maybeDone();
          } else if (event.type === 'test:fail') {
            settled++;
            fail++;
            const err = (event.data as any).error;
            lines.push('not ok ' + event.data.name + ' ' + (err ? String(err.message ?? err) : ''));
            armIdle();
            maybeDone();
          } else if (event.type === 'test:skip' || event.type === 'test:todo') {
            settled++;
            lines.push('skip ' + event.data.name);
            armIdle();
            maybeDone();
          }
        }
        // stream ended (isolation implementations may emit 'end' after all)
        finish({ exitCode: fail === 0 ? 0 : 1, timedOut: false, output: lines.join('\n') });
      } catch (err) {
        lines.push('runner error: ' + String(err));
        finish({ exitCode: 1, timedOut: false, output: lines.join('\n') });
      }
    })();
  });
}
// Recursive copy via mkdir+copyFile (fs.cpSync crashes in some sandboxed
// environments; this also skips node_modules and VCS metadata).
function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) copyTree(s, d);
    else copyFileSync(s, d);
  }
}
export class Kernel {
  private readonly opts: KernelOptions;
  constructor(opts: KernelOptions) {
    this.opts = opts;
  }

  // Execute one mutant against the project test suite.
  async execute(projectDir: string, mutant: Mutant, runId: string): Promise<MutantResult> {
    const started = Date.now();
    const log = this.opts.logger ?? (() => {});
    const workDir = mkdtempSync(join(tmpdir(), 'mts-' + runId.slice(0, 8) + '-'));
    try {
      copyTree(projectDir, workDir);
      const target = join(workDir, mutant.file);
      const original = readFileSync(target, 'utf8');
      const mutated = applyMutant(original, mutant);
      writeFileSync(target, mutated, 'utf8');
      log('[kernel] run=' + runId + ' mutant=' + mutant.id +
        ' applied ' + mutant.original + ' -> ' + JSON.stringify(mutant.replacement) +
        ' at ' + mutant.file + ':' + mutant.line);

      const outcome = this.opts.executor === 'inprocess'
        ? await runTestsInProcess(workDir, this.opts.timeoutMs)
        : await runTestsSpawn(workDir, this.opts.testCommand, this.opts.timeoutMs);
      const tail = outcome.output.slice(-this.opts.outputTailChars);
      const durationMs = Date.now() - started;

      let status: MutantStatus;
      let reason: string;
      if (outcome.timedOut) {
        status = 'timeout';
        reason = 'test suite exceeded ' + this.opts.timeoutMs + 'ms under mutant; counted as killed';
      } else if (outcome.exitCode === 0) {
        status = 'survived';
        reason = 'test suite passed (exit 0) with mutant applied; no test detected the change';
      } else {
        status = 'killed';
        reason = 'test suite failed (exit ' + outcome.exitCode + ') with mutant applied';
      }
      log('[kernel] run=' + runId + ' mutant=' + mutant.id + ' status=' + status +
        ' exit=' + String(outcome.exitCode) + ' durationMs=' + durationMs + ' reason="' + reason + '"');
      return { mutant, status, durationMs, reason, testExitCode: outcome.exitCode, testOutputTail: tail };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

