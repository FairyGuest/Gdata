// Execution kernel: validates requests, generates mutants, runs the test
// suite once per mutant in an isolated workspace copy, and classifies results.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MutantOutcome, MutantSpec, RunReport, RunRequest, MutatorType } from './contracts.ts';
import { inputError, stateConflict, resourceExhausted } from './errors.ts';
import { generateMutants, applyMutant, ALL_MUTATORS } from './mutators.ts';
import type { ServiceConfig } from './config.ts';

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError?: string;
  tail: string;
}

// Split a simple command line into argv, honoring double-quoted segments.
// Spawning without a shell avoids cmd.exe quoting bugs and works in
// restricted sandboxes where shell spawning is denied.
const splitCommand = (command) => {
  const argv = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(command)) !== null) argv.push(m[1] ?? m[2]);
  return argv;
};

const runCommand = (command, cwd, timeoutMs, logFile) =>
  new Promise((resolve) => {
    let [file, ...args] = splitCommand(command);
    // Bare 'node' resolves through PATH, which restricted environments may
    // refuse to spawn; prefer the current interpreter's absolute path.
    if (file === 'node' || file === 'node.exe') file = process.execPath;
    if (!file) {
      resolve({ code: null, signal: null, timedOut: false, spawnError: 'empty test command', tail: '' });
      return;
    }
    const finish = (result) => {
      let out = result.spawnError ? '' : readTail(logFile);
      resolve({ ...result, tail: out });
    };
    let outFd;
    try {
      outFd = fs.openSync(logFile, 'w');
    } catch (err) {
      resolve({ code: null, signal: null, timedOut: false, spawnError: 'cannot open log file: ' + err.message, tail: '' });
      return;
    }
    const child = spawn(file, args, {
      cwd,
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      stdio: ['ignore', outFd, outFd],
    });
    child.on('error', (err) => {
      fs.closeSync(outFd);
      finish({ code: null, signal: null, timedOut: false, spawnError: err.message });
    });
    child.on('close', (code, signal) => {
      fs.closeSync(outFd);
      finish({ code, signal, timedOut: signal === 'SIGTERM' && code === null });
    });
  });

const readTail = (logFile) => {
  try {
    const text = fs.readFileSync(logFile, 'utf8');
    return (text.length > 8192 ? text.slice(-8192) : text).trim();
  } catch {
    return '';
  }
};
const copyProject = (src, dest) => {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    const base = path.basename(src);
    if (base === 'node_modules' || base === '.git') return;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyProject(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.writeFileSync(dest, fs.readFileSync(src));
  }
};
export class MutationKernel {
  private readonly busyProjects = new Set<string>();
  private seq = 0;

  private readonly config: ServiceConfig;

  constructor(config: ServiceConfig) {
    this.config = config;
  }

  nextRunId(now = new Date()): string {
    this.seq += 1;
    const stamp = now.toISOString().slice(0, 10).replaceAll('-', '');
    return 'R-' + stamp + '-' + String(this.seq).padStart(4, '0');
  }

  async execute(request: RunRequest, runId: string): Promise<RunReport> {
    const startedAt = new Date();
    const log: string[] = [];
    const say = (msg: string) => {
      const line = '[' + runId + '] ' + msg;
      log.push(line);
      console.log(line);
    };

    const projectDir = path.resolve(String(request.projectDir ?? ''));
    if (!request.projectDir || !fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
      throw inputError('projectDir does not exist or is not a directory: ' + String(request.projectDir));
    }
    const sourceFile = String(request.sourceFile ?? '');
    const absSource = path.resolve(projectDir, sourceFile);
    if (absSource !== projectDir && !absSource.startsWith(projectDir + path.sep)) {
      throw inputError('sourceFile escapes projectDir: ' + sourceFile);
    }
    if (!fs.existsSync(absSource)) {
      throw inputError('sourceFile not found inside projectDir: ' + sourceFile);
    }
    const timeoutMs = Number(request.timeoutMs ?? this.config.defaultTimeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw inputError('timeoutMs must be a positive number, got: ' + String(request.timeoutMs));
    }
    if (timeoutMs > this.config.maxTimeoutMs) {
      throw resourceExhausted('timeoutMs ' + timeoutMs + ' exceeds configured max ' + this.config.maxTimeoutMs);
    }
    const mutators = (request.mutators ?? ALL_MUTATORS) as MutatorType[];
    for (const m of mutators) {
      if (!ALL_MUTATORS.includes(m)) throw inputError('unknown mutator: ' + String(m));
    }
    const testCommand = request.testCommand ?? this.config.defaultTestCommand;

    if (this.busyProjects.has(projectDir)) {
      throw stateConflict('a mutation run is already active for projectDir: ' + projectDir);
    }
    this.busyProjects.add(projectDir);

    const workspaceBase = this.config.workspaceRoot || path.join(os.tmpdir(), 'mutation-testing-workspaces');
    const runWorkspace = path.join(workspaceBase, runId);

    try {
      say('run started project=' + projectDir + ' source=' + sourceFile + ' cmd="' + testCommand + '" timeoutMs=' + timeoutMs);

      // Baseline: the unmutated suite must pass, otherwise scores are meaningless.
      const baselineDir = path.join(runWorkspace, 'baseline');
      copyProject(projectDir, baselineDir);
      say('baseline: running test suite on unmutated code');
      const baseline = await runCommand(testCommand, baselineDir, timeoutMs, path.join(runWorkspace, 'baseline.log'));
      if (baseline.timedOut) {
        say('baseline: TIMEOUT after ' + timeoutMs + 'ms; aborting run');
        return this.report(runId, 'baseline_failed', projectDir, sourceFile, testCommand, [], log, startedAt);
      }
      if (baseline.spawnError) {
        say('baseline: SPAWN ERROR ' + baseline.spawnError + '; aborting run');
        return this.report(runId, 'baseline_failed', projectDir, sourceFile, testCommand, [], log, startedAt);
      }
      if (baseline.code !== 0) {
        say('baseline: FAILED exit=' + baseline.code + '; unmutated tests must pass. tail: ' + baseline.tail.split('\n').slice(-3).join(' | '));
        return this.report(runId, 'baseline_failed', projectDir, sourceFile, testCommand, [], log, startedAt);
      }
      say('baseline: OK (exit=0)');

      const source = fs.readFileSync(absSource, 'utf8');
      const mutants = generateMutants(source, sourceFile, mutators);
      say('generated ' + mutants.length + ' mutants from ' + sourceFile);

      const outcomes: MutantOutcome[] = [];
      for (const mutant of mutants) {
        outcomes.push(await this.executeMutant(mutant, projectDir, sourceFile, source, testCommand, timeoutMs, runWorkspace, say));
      }
      const report = this.report(runId, 'completed', projectDir, sourceFile, testCommand, outcomes, log, startedAt);
      say('run completed score=' + report.score + ' killed=' + report.killed + '/' + report.total +
        ' survived=' + report.survived + ' timeout=' + report.timeout + ' error=' + report.error);
      return report;
    } finally {
      this.busyProjects.delete(projectDir);
      fs.rmSync(runWorkspace, { recursive: true, force: true });
    }
  }

  private async executeMutant(
    mutant: MutantSpec,
    projectDir: string,
    sourceFile: string,
    source: string,
    testCommand: string,
    timeoutMs: number,
    runWorkspace: string,
    say: (msg: string) => void,
  ): Promise<MutantOutcome> {
    const t0 = Date.now();
    const dir = path.join(runWorkspace, mutant.id);
    let outcome: MutantOutcome;
    try {
      copyProject(projectDir, dir);
      const mutated = applyMutant(source, mutant);
      fs.writeFileSync(path.join(dir, sourceFile), mutated);
      const result = await runCommand(testCommand, dir, timeoutMs, path.join(runWorkspace, mutant.id + '.log'));
      const durationMs = Date.now() - t0;
      if (result.timedOut) {
        outcome = { ...mutant, status: 'timeout', reason: 'test command exceeded timeoutMs=' + timeoutMs + ' (resource exhaustion)', durationMs };
      } else if (result.spawnError) {
        outcome = { ...mutant, status: 'error', reason: 'failed to spawn test command: ' + result.spawnError, durationMs };
      } else if (result.code === 0) {
        outcome = { ...mutant, status: 'survived', reason: 'test suite passed (exit=0); mutation NOT detected', durationMs };
      } else {
        outcome = { ...mutant, status: 'killed', reason: 'test suite failed (exit=' + result.code + '); mutation detected', durationMs };
      }
    } catch (err) {
      outcome = { ...mutant, status: 'error', reason: 'kernel error: ' + (err instanceof Error ? err.message : String(err)), durationMs: Date.now() - t0 };
    }
    say(mutant.id + ' ' + mutant.mutator + ' @' + sourceFile + ':' + mutant.offset +
      ' -> ' + outcome.status.toUpperCase() + ' (' + outcome.reason + ') [' + outcome.preview + ']');
    return outcome;
  }

  private report(
    runId: string,
    status: RunReport['status'],
    projectDir: string,
    sourceFile: string,
    testCommand: string,
    outcomes: MutantOutcome[],
    log: string[],
    startedAt: Date,
  ): RunReport {
    const killed = outcomes.filter((o) => o.status === 'killed').length;
    const survived = outcomes.filter((o) => o.status === 'survived').length;
    const timeout = outcomes.filter((o) => o.status === 'timeout').length;
    const error = outcomes.filter((o) => o.status === 'error').length;
    const total = outcomes.length;
    return {
      runId,
      status,
      projectDir,
      sourceFile,
      testCommand,
      score: total === 0 ? 0 : killed / total,
      total,
      killed,
      survived,
      timeout,
      error,
      survivors: outcomes.filter((o) => o.status === 'survived'),
      mutants: outcomes,
      log,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
    };
  }
}
