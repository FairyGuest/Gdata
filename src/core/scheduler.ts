/**
 * Execution kernel: consumes change events, computes rebuild sets, and drives
 * the per-target state machine (queued -> building -> success|failed).
 *
 * - Targets already 'building' when a new event lands are not re-queued;
 *   they are marked pendingRebuild and folded into a follow-up round.
 * - A failed target blocks its downstream dependents for that run.
 * - A target whose fingerprint matches the last successful build is skipped.
 */

import { resourceExhausted } from '../domain/errors.ts';
import type { BuildOutcome, BuildRecord, TargetState } from '../domain/types.ts';
import { buildGraph, computeAffected, topoOrder, type TargetGraph } from './graph.ts';
import { fingerprintPaths } from './fingerprint.ts';
import { BuildFailure, FixtureRunner } from '../fixtures/runner.ts';
import type { SqliteStore } from '../store/sqliteStore.ts';
import type { ServiceConfig, TargetDefinition, TargetStatus } from '../domain/types.ts';

interface QueueItem {
  runId: number;
  target: string;
}

export class Scheduler {
  private graph: TargetGraph;
  private readonly states = new Map<string, TargetState>();
  private readonly pendingRebuild = new Set<string>();
  private readonly queue: QueueItem[] = [];
  private processing = false;
  /** runId -> outcomes observed so far in that run (for dependency blocking) */
  private readonly runOutcomes = new Map<number, Map<string, BuildOutcome>>();
  private readonly runWaiters = new Map<number, Array<() => void>>();

  private readonly store: SqliteStore;
  private readonly runner: FixtureRunner;
  private readonly config: ServiceConfig;

  constructor(
    store: SqliteStore,
    runner: FixtureRunner,
    config: ServiceConfig,
    defs: TargetDefinition[],
  ) {
    this.store = store;
    this.runner = runner;
    this.config = config;
    this.graph = buildGraph(defs);
  }

  replaceTargets(defs: TargetDefinition[]): void {
    this.graph = buildGraph(defs);
    this.store.replaceTargets(defs);
  }

  get targetCount(): number {
    return this.graph.targets.size;
  }

  status(): TargetStatus[] {
    const out: TargetStatus[] = [];
    for (const name of [...this.graph.targets.keys()].sort()) {
      const last = this.store.getLastBuild(name);
      out.push({
        name,
        state: this.states.get(name) ?? 'idle',
        pendingRebuild: this.pendingRebuild.has(name),
        lastOutcome: last?.outcome ?? null,
        lastReason: last?.reason ?? null,
        lastFingerprint: this.store.getFingerprint(name),
      });
    }
    return out;
  }

  /** Accept a change-event batch. Returns the run identity and plan. */
  submit(changedPaths: string[]): { runId: number; direct: string[]; affected: string[]; order: string[] } {
    const { direct, affected } = computeAffected(this.graph, changedPaths);
    if (affected.length > this.config.maxRebuildSetSize) {
      throw resourceExhausted('rebuild set exceeds maxRebuildSetSize', {
        size: affected.length, max: this.config.maxRebuildSetSize,
      });
    }
    const order = topoOrder(this.graph, affected);
    const runId = this.store.nextRunId();
    this.store.createRun(runId, changedPaths, affected, order);
    this.runOutcomes.set(runId, new Map());
    let queued = 0;
    for (const target of order) {
      if (this.states.get(target) === 'building' || this.queue.some((q) => q.target === target)) {
        // Already in flight: merge into a pending rebuild instead of double-queueing.
        this.pendingRebuild.add(target);
        this.record(runId, target, 'skipped', 'merged: already building/queued, deferred to next round', null);
        this.runOutcomes.get(runId)!.set(target, 'skipped');
      } else {
        this.states.set(target, 'queued');
        this.queue.push({ runId, target });
        queued++;
      }
    }
    if (queued === 0) {
      this.store.finishRun(runId);
      this.notifyRun(runId);
    }
    void this.processLoop();
    return { runId, direct, affected, order };
  }

  /** Resolves when the run (including any merged follow-up rounds) completes. */
  waitForRun(runId: number): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run || run.status === 'completed') return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.runWaiters.get(runId) ?? [];
      list.push(resolve);
      this.runWaiters.set(runId, list);
    });
  }

  private record(runId: number, target: string, outcome: BuildOutcome, reason: string | null, fingerprint: string | null): BuildRecord {
    const now = new Date().toISOString();
    const rec: BuildRecord = { runId, target, outcome, reason, fingerprint, startedAt: now, finishedAt: now };
    this.store.insertBuild(rec);
    return rec;
  }

  private async processLoop(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        await this.buildOne(item);
      }
      // Fold merged pending rebuilds into a follow-up round.
      if (this.pendingRebuild.size > 0) {
        const seeds = [...this.pendingRebuild].sort();
        this.pendingRebuild.clear();
        const closure = new Set<string>(seeds);
        const stack = [...seeds];
        while (stack.length > 0) {
          const cur = stack.pop()!;
          for (const next of this.graph.dependents.get(cur) ?? []) {
            if (!closure.has(next)) { closure.add(next); stack.push(next); }
          }
        }
        const order = topoOrder(this.graph, [...closure]);
        const runId = this.store.nextRunId();
        this.store.createRun(runId, [], [...closure].sort(), order);
        this.runOutcomes.set(runId, new Map());
        for (const target of order) {
          this.states.set(target, 'queued');
          this.queue.push({ runId, target });
        }
        while (this.queue.length > 0) {
          const item = this.queue.shift()!;
          await this.buildOne(item);
        }
        this.store.finishRun(runId);
        this.notifyRun(runId);
      }
    } finally {
      this.processing = false;
    }
  }

  private async buildOne(item: QueueItem): Promise<void> {
    const { runId, target } = item;
    const def = this.graph.targets.get(target)!;
    const outcomes = this.runOutcomes.get(runId)!;

    // Dependency gate: any failed/blocked upstream blocks this target.
    const blocker = def.deps.find((d) => {
      const o = outcomes.get(d);
      return o === 'failed' || o === 'blocked';
    });
    if (blocker) {
      this.record(runId, target, 'blocked', `blocked: upstream ${blocker} did not succeed`, null);
      outcomes.set(target, 'blocked');
      this.states.set(target, 'failed');
      this.finishRunIfDrained(runId);
      return;
    }

    this.states.set(target, 'building');
    const startedAt = new Date().toISOString();
    const fingerprint = fingerprintPaths(this.config.workspaceRoot, def.paths);
    const lastFingerprint = this.store.getFingerprint(target);
    const last = this.store.getLastBuild(target);

    if (lastFingerprint === fingerprint && last?.outcome === 'success') {
      const rec: BuildRecord = {
        runId, target, outcome: 'skipped',
        reason: `fingerprint unchanged (${fingerprint.slice(0, 12)}...)`,
        fingerprint, startedAt, finishedAt: new Date().toISOString(),
      };
      this.store.insertBuild(rec);
      outcomes.set(target, 'skipped');
      this.states.set(target, 'success');
      this.finishRunIfDrained(runId);
      return;
    }

    try {
      await this.runner.execute(def);
      this.store.setFingerprint(target, fingerprint);
      const rec: BuildRecord = {
        runId, target, outcome: 'success', reason: null, fingerprint,
        startedAt, finishedAt: new Date().toISOString(),
      };
      this.store.insertBuild(rec);
      outcomes.set(target, 'success');
      this.states.set(target, 'success');
    } catch (err) {
      const reason = err instanceof BuildFailure ? err.message : `unexpected executor error: ${String(err)}`;
      const rec: BuildRecord = {
        runId, target, outcome: 'failed', reason, fingerprint,
        startedAt, finishedAt: new Date().toISOString(),
      };
      this.store.insertBuild(rec);
      outcomes.set(target, 'failed');
      this.states.set(target, 'failed');
    }
    this.finishRunIfDrained(runId);
  }

  private finishRunIfDrained(runId: number): void {
    const stillQueued = this.queue.some((q) => q.runId === runId);
    if (!stillQueued) {
      this.store.finishRun(runId);
      this.notifyRun(runId);
    }
  }

  private notifyRun(runId: number): void {
    for (const resolve of this.runWaiters.get(runId) ?? []) resolve();
    this.runWaiters.delete(runId);
  }
}