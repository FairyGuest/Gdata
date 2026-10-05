// Run orchestration: ties config -> engine -> stats -> store together and
// enforces the resource limit on concurrent runs. Emits structured log lines
// carrying the run id, key intermediate states and judgment reasons so a run
// can be replayed from logs.

import { randomUUID } from "node:crypto";
import { AppError } from "./errors.ts";
import { executeRun } from "./engine.ts";
import { computeStats } from "./stats.ts";
import type { Store } from "./store.ts";
import type { FailureKind, RunConfig, RunSummary } from "./types.ts";

export interface RunnerOptions {
  maxConcurrentRuns?: number;
  logger?: (line: string) => void;
}

export class Runner {
  private store: Store;
  private maxConcurrentRuns: number;
  private activeRuns = 0;
  private log: (line: string) => void;
  readonly recentErrors: Array<{ at: string; runId: string | null; code: string; message: string }> = [];

  constructor(store: Store, opts: RunnerOptions = {}) {
    this.store = store;
    this.maxConcurrentRuns = opts.maxConcurrentRuns ?? 4;
    this.log = opts.logger ?? ((line) => console.log(line));
  }

  get activeCount(): number {
    return this.activeRuns;
  }

  private noteError(runId: string | null, code: string, message: string): void {
    this.recentErrors.push({ at: new Date().toISOString(), runId, code, message });
    if (this.recentErrors.length > 50) this.recentErrors.shift();
  }

  private logRun(runId: string, state: string, reason: string): void {
    this.log(`[run=${runId}] state=${state} reason=${reason}`);
  }

  // Starts a run asynchronously; returns the run id immediately (HTTP 202).
  startRun(config: RunConfig): string {
    if (this.activeRuns >= this.maxConcurrentRuns) {
      const err = new AppError("RESOURCE_EXHAUSTED",
        `too many concurrent runs (limit=${this.maxConcurrentRuns})`,
        { activeRuns: this.activeRuns });
      this.noteError(null, err.code, err.message);
      throw err;
    }
    const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    this.store.createRun(runId, config, startedAt);
    this.activeRuns++;
    this.logRun(runId, "accepted", `config=${JSON.stringify(config)}`);
    void this.execute(runId, config).finally(() => { this.activeRuns--; });
    return runId;
  }

  private async execute(runId: string, config: RunConfig): Promise<void> {
    const t0 = performance.now();
    try {
      const results = await executeRun(config, {
        onResult: (r) => this.logRun(runId, "request", `seq=${r.seq} outcome=${r.outcome} status=${r.statusCode} latencyMs=${r.latencyMs.toFixed(1)} kind=${r.failureKind ?? "-"}`),
      });
      this.store.insertResults(runId, results);
      this.logRun(runId, "persisted", `stored ${results.length}/${config.totalRequests} results`);

      const successLat = results.filter((r) => r.outcome === "success").map((r) => r.latencyMs);
      const failureLat = results.filter((r) => r.outcome === "failure").map((r) => r.latencyMs);
      const failuresByKind: Record<FailureKind, number> = { http_error: 0, timeout: 0, network_error: 0 };
      for (const r of results) if (r.failureKind) failuresByKind[r.failureKind]++;

      const finishedAt = new Date().toISOString();
      const durationMs = performance.now() - t0;
      const summary: RunSummary = {
        runId,
        targetUrl: config.targetUrl,
        config,
        startedAt: this.store.getRun(runId)!.startedAt,
        finishedAt,
        durationMs,
        totalRequests: results.length,
        successCount: successLat.length,
        failureCount: failureLat.length,
        failuresByKind,
        throughputRps: durationMs > 0 ? results.length / (durationMs / 1000) : 0,
        successStats: successLat.length ? computeStats(successLat) : null,
        failureStats: failureLat.length ? computeStats(failureLat) : null,
      };
      this.store.finishRun(runId, "completed", finishedAt, summary, null);
      this.logRun(runId, "completed",
        `success=${summary.successCount} failure=${summary.failureCount} kinds=${JSON.stringify(failuresByKind)} rps=${summary.throughputRps.toFixed(2)}`);
    } catch (err) {
      const code = err instanceof AppError ? err.code : "INTERNAL_ERROR";
      const message = err instanceof Error ? err.message : String(err);
      this.noteError(runId, code, message);
      this.store.finishRun(runId, "failed", new Date().toISOString(), null, { code, message });
      this.logRun(runId, "failed", `code=${code} message=${message}`);
    }
  }
}
