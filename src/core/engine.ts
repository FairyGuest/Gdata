// Execution kernel: consumes change events, computes the rebuild set,
// schedules builds in topological order, applies fingerprint skipping,
// failure blocking and mid-build change coalescing.

import { ContractError, ComputationError, ResourceExhaustedError, StateConflictError } from "../domain/errors.ts";
import type { LogEntry, RunReport, TargetOutcome, TargetState } from "../domain/types.ts";
import { affectedClosure, downstreamWithin, topoOrder, type TargetGraph } from "./graph.ts";
import { computeFingerprint } from "./fingerprint.ts";
import type { BuildStore } from "../store/sqlite.ts";
import type { Builder } from "../adapters/builder.ts";

export interface EngineConfig {
  workspaceRoot: string;
  maxQueueSize: number;
}

export interface Logger {
  log(entry: LogEntry): void;
}

interface Run {
  id: string;
  changedPaths: string[];
  affected: Set<string>;
  order: string[];
  outcomes: Map<string, TargetOutcome>;
  startedAt: string;
  resolve: (report: RunReport) => void;
}

export class Engine {
  private graph: TargetGraph | null = null;
  private readonly states = new Map<string, TargetState>();
  private readonly queue: string[] = [];
  /** targets currently building that were re-affected: rebuild once after */
  private readonly pendingRebuild = new Set<string>();
  /** target -> runs waiting for its next terminal outcome */
  private readonly waitingRuns = new Map<string, Set<string>>();
  private readonly runs = new Map<string, Run>();
  private readonly completedRuns: RunReport[] = [];
  private runCounter = 0;
  private pumping = false;

  private readonly deps: {
    store: BuildStore;
    builder: Builder;
    config: EngineConfig;
    logger: Logger;
  };

  constructor(deps: {
    store: BuildStore;
    builder: Builder;
    config: EngineConfig;
    logger: Logger;
  }) {
    this.deps = deps;
  }

  setGraph(graph: TargetGraph): void {
    if (this.statesBuildingOrQueued() > 0) {
      throw new StateConflictError("cannot redefine targets while builds are queued or running");
    }
    this.graph = graph;
    this.emit(null, null, "targets-registered", "targets=" + [...graph.targets.keys()].sort().join(","));
  }

  hasGraph(): boolean {
    return this.graph !== null;
  }

  targetState(name: string): TargetState {
    return this.states.get(name) ?? "idle";
  }

  listRuns(): RunReport[] {
    return [...this.completedRuns];
  }

  getRun(runId: string): RunReport | null {
    return this.completedRuns.find((r) => r.runId === runId) ?? null;
  }

  private statesBuildingOrQueued(): number {
    let n = 0;
    for (const s of this.states.values()) if (s !== "idle") n++;
    return n;
  }

  /** Submit a change batch; resolves with the run report once all affected targets settle. */
  submitChanges(paths: unknown): Promise<RunReport> {
    if (this.graph === null) throw new StateConflictError("no targets registered yet");
    if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== "string" || p.length === 0)) {
      throw new ContractError("'paths' must be a non-empty array of non-empty strings");
    }
    const changedPaths = [...new Set(paths as string[])];
    const affected = affectedClosure(this.graph, changedPaths);
    const runId = "run-" + String(++this.runCounter).padStart(4, "0");
    const order = topoOrder(this.graph, affected);
    this.emit(runId, null, "run-created", "changed=[" + changedPaths.join(",") + "] affected=[" + [...affected].sort().join(",") + "] order=[" + order.join(",") + "]");

    let resolveFn!: (r: RunReport) => void;
    const promise = new Promise<RunReport>((res) => (resolveFn = res));
    const run: Run = {
      id: runId,
      changedPaths,
      affected,
      order,
      outcomes: new Map(),
      startedAt: new Date().toISOString(),
      resolve: resolveFn,
    };
    this.runs.set(runId, run);

    if (affected.size === 0) {
      this.emit(runId, null, "run-noop", "no target watches the changed paths");
      this.finishRun(run);
      return promise;
    }

    for (const name of order) this.dispatch(name, runId);
    void this.pump();
    return promise;
  }

  /** Route an affected target: merge into in-flight/queued work or enqueue. */
  private dispatch(name: string, runId: string): void {
    const state = this.states.get(name) ?? "idle";
    let waiting = this.waitingRuns.get(name);
    if (!waiting) {
      waiting = new Set();
      this.waitingRuns.set(name, waiting);
    }
    if (state === "building") {
      // Do not double-queue: coalesce into one pending rebuild after the current build.
      this.pendingRebuild.add(name);
      waiting.add(runId);
      this.emit(runId, name, "merged-into-building", "target is building; registered as pending rebuild");
      return;
    }
    if (state === "queued") {
      // Already queued: the queued build will observe the new content, just attach the run.
      waiting.add(runId);
      this.emit(runId, name, "merged-into-queued", "target already queued; change merged");
      return;
    }
    if (this.queue.length >= this.deps.config.maxQueueSize) {
      throw new ResourceExhaustedError("build queue is full (maxQueueSize=" + this.deps.config.maxQueueSize + ")");
    }
    waiting.add(runId);
    this.states.set(name, "queued");
    this.queue.push(name);
    this.emit(runId, name, "queued", "state idle->queued");
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const name = this.queue.shift()!;
        // Snapshot the runs waiting at build start. Runs that arrive while
        // this build executes belong to the NEXT round (pending rebuild).
        const runIds = new Set(this.waitingRuns.get(name) ?? []);
        this.waitingRuns.delete(name);
        this.states.set(name, "building");
        this.emit(null, name, "build-started", "state queued->building; runs=[" + [...runIds].join(",") + "]");
        const outcome = await this.executeTarget(name);
        this.deliver(name, outcome, runIds);
        if (this.pendingRebuild.has(name)) {
          this.pendingRebuild.delete(name);
          this.states.set(name, "queued");
          this.queue.push(name);
          this.emit(null, name, "requeued-after-merge", "pending rebuild enters next round");
        } else {
          this.states.set(name, "idle");
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Fingerprint check + build invocation for one target. */
  private async executeTarget(name: string): Promise<TargetOutcome> {
    const started = Date.now();
    const def = this.graph!.targets.get(name)!;
    let fingerprint: string;
    try {
      fingerprint = computeFingerprint(this.deps.config.workspaceRoot, def.watchPaths);
    } catch (err) {
      throw new ComputationError("fingerprint computation failed for '" + name + "': " + (err as Error).message);
    }
    const previous = this.deps.store.getFingerprint(name);
    if (previous !== null && previous === fingerprint) {
      const reason = "fingerprint unchanged since last build (" + fingerprint.slice(0, 12) + "...)";
      this.emit(null, name, "skipped", reason);
      return { target: name, status: "skipped", reason, fingerprint, durationMs: Date.now() - started };
    }
    const result = await this.deps.builder.build({
      name,
      watchPaths: def.watchPaths,
      workspaceRoot: this.deps.config.workspaceRoot,
    });
    const durationMs = Date.now() - started;
    if (result.ok) {
      this.deps.store.saveFingerprint(name, fingerprint);
      this.emit(null, name, "build-succeeded", "fingerprint=" + fingerprint.slice(0, 12) + "...");
      return { target: name, status: "success", fingerprint, durationMs };
    }
    this.emit(null, name, "build-failed", result.error ?? "unknown builder error");
    return { target: name, status: "failed", reason: result.error ?? "unknown builder error", fingerprint, durationMs };
  }

  /** Record an outcome to the given runs; propagate failure as blocked downstream. */
  private deliver(name: string, outcome: TargetOutcome, runIds: Set<string>): void {
    this.deps.store.recordBuild({
      runId: [...runIds].join("+") || "none",
      target: name,
      status: outcome.status,
      reason: outcome.reason ?? null,
      blockedBy: outcome.blockedBy ?? null,
      fingerprint: outcome.fingerprint ?? null,
      durationMs: outcome.durationMs,
    });
    for (const runId of runIds) {
      const run = this.runs.get(runId);
      if (!run) continue;
      run.outcomes.set(name, outcome);
      if (outcome.status === "failed") {
        // Downstream targets of this run are blocked, never queued.
        for (const d of downstreamWithin(this.graph!, name, run.affected)) {
          if (run.outcomes.has(d)) continue;
          const blocked: TargetOutcome = {
            target: d,
            status: "blocked",
            reason: "upstream '" + name + "' failed",
            blockedBy: name,
            durationMs: 0,
          };
          run.outcomes.set(d, blocked);
          this.emit(runId, d, "blocked", "upstream '" + name + "' failed; not queued");
          this.deps.store.recordBuild({
            runId, target: d, status: "blocked",
            reason: blocked.reason!, blockedBy: name, fingerprint: null, durationMs: 0,
          });
          // Drop queued entries that only this run waited on.
          const w = this.waitingRuns.get(d);
          if (w) {
            w.delete(runId);
            if (w.size === 0) {
              this.waitingRuns.delete(d);
              const idx = this.queue.indexOf(d);
              if (idx >= 0) {
                this.queue.splice(idx, 1);
                this.states.set(d, "idle");
              }
            }
          }
        }
      }
      if (run.outcomes.size === run.affected.size) this.finishRun(run);
    }
  }

  private finishRun(run: Run): void {
    const report: RunReport = {
      runId: run.id,
      changedPaths: run.changedPaths,
      affected: [...run.affected].sort(),
      order: run.order,
      outcomes: run.order
        .map((n) => run.outcomes.get(n))
        .filter((o): o is TargetOutcome => o !== undefined),
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
    };
    this.runs.delete(run.id);
    this.completedRuns.push(report);
    this.emit(run.id, null, "run-finished", "outcomes=" + report.outcomes.map((o) => o.target + ":" + o.status).join(","));
    run.resolve(report);
  }

  private emit(runId: string | null, target: string | null, event: string, detail: string): void {
    this.deps.logger.log({ at: new Date().toISOString(), runId, target, event, detail });
  }
}
