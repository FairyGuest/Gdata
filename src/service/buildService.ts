/** Service facade: validates contracts, owns store + scheduler. */

import { inputError, notFound, resourceExhausted, stateConflict } from '../domain/errors.ts';
import type { AppConfig } from '../config.ts';
import type { RunResult, TargetDefinition, TargetStatus } from '../domain/types.ts';
import { Scheduler } from '../core/scheduler.ts';
import { FixtureRunner } from '../fixtures/runner.ts';
import { SqliteStore } from '../store/sqliteStore.ts';

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

export class BuildService {
  readonly store: SqliteStore;
  readonly runner: FixtureRunner;
  private scheduler: Scheduler;
  private registered = false;

  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.store = new SqliteStore(config.dbPath);
    this.runner = new FixtureRunner(config.workspaceRoot, config.buildDelayMs);
    this.scheduler = new Scheduler(this.store, this.runner, config, []);
  }

  close(): void {
    this.store.close();
  }

  registerTargets(defs: TargetDefinition[]): { registered: string[] } {
    if (this.registered) {
      throw stateConflict('targets already registered; restart the service to redefine the graph');
    }
    if (!Array.isArray(defs) || defs.length === 0) {
      throw inputError('targets must be a non-empty array');
    }
    if (defs.length > this.config.maxTargets) {
      throw resourceExhausted('too many targets', { count: defs.length, max: this.config.maxTargets });
    }
    for (const d of defs ?? []) {
      if (!d || !NAME_RE.test(d.name ?? '')) {
        throw inputError('invalid target name (allowed: [A-Za-z0-9_.-])', { name: d?.name });
      }
      for (const p of d.paths ?? []) {
        if (typeof p !== 'string' || p.includes('..') || p.startsWith('/')) {
          throw inputError('watched paths must be workspace-relative without ".."', { path: p });
        }
      }
    }
    // Graph validation (unknown deps, duplicates, cycles) happens in buildGraph.
    this.scheduler.replaceTargets(defs);
    this.registered = true;
    return { registered: defs.map((d) => d.name).sort() };
  }

  submitEvents(paths: string[]): { runId: number; direct: string[]; affected: string[]; order: string[] } {
    if (!this.registered) throw stateConflict('no targets registered yet');
    if (!Array.isArray(paths) || paths.length === 0) {
      throw inputError('paths must be a non-empty array of strings');
    }
    for (const p of paths) {
      if (typeof p !== 'string' || p.includes('..') || p.startsWith('/')) {
        throw inputError('changed paths must be workspace-relative without ".."', { path: p });
      }
    }
    return this.scheduler.submit(paths);
  }

  getRun(runId: number): RunResult {
    if (!Number.isInteger(runId) || runId < 1) throw inputError('runId must be a positive integer');
    const run = this.store.getRun(runId);
    if (!run) throw notFound(`no such run: ${runId}`);
    return run;
  }

  getTarget(name: string): { status: TargetStatus; lastBuild: unknown; skips: unknown[]; history: unknown[] } {
    const status = this.scheduler.status().find((s) => s.name === name);
    if (!status) throw notFound(`no such target: ${name}`);
    return {
      status,
      lastBuild: this.store.getLastBuild(name),
      skips: this.store.getSkips(name),
      history: this.store.getHistory(name),
    };
  }

  getState(): TargetStatus[] {
    return this.scheduler.status();
  }

  async waitForRun(runId: number): Promise<RunResult> {
    await this.scheduler.waitForRun(runId);
    return this.getRun(runId);
  }

  /** Wait until the kernel is fully idle (no queued/building/pending targets). */
  async waitForIdle(timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const busy = this.scheduler.status().some((s) => s.state === 'queued' || s.state === 'building' || s.pendingRebuild);
      if (!busy) return;
      if (Date.now() > deadline) throw new Error('timed out waiting for scheduler idle');
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}