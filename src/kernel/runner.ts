import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { resourceExhausted } from "../contract/errors.ts";
import type { DiscoveredFile, RawCaseOutcome, RunEvent } from "../contract/types.ts";

export interface RunOptions {
  files: DiscoveredFile[];
  /** Max number of cases executing at the same time. */
  parallel: number;
  /** Per-case timeout in milliseconds. */
  timeoutMs: number;
  /** Optional run id; generated when omitted. */
  runId?: string;
  /** Sink for structured replayable events. */
  onEvent?: (ev: RunEvent) => void;
}

export interface RunOutcome {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Outcomes keyed by caseId "<file>#<case>". */
  outcomes: Map<string, RawCaseOutcome>;
}

const WORKER_PATH = fileURLToPath(new URL("./case-worker.ts", import.meta.url));

/** Execute one case in a dedicated worker; terminate it on timeout. */
function runCase(
  absPath: string,
  caseName: string,
  timeoutMs: number,
): Promise<RawCaseOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    const worker = new Worker(WORKER_PATH, { workerData: { absPath, caseName } });
    let settled = false;
    const finish = (outcome: RawCaseOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish({ kind: "timeout", durationMs: Date.now() - started, timeoutMs });
    }, timeoutMs);
    worker.on("message", (msg: { error?: { name: string; message: string; stack?: string } }) => {
      const durationMs = Date.now() - started;
      if (msg.error) finish({ kind: "error", durationMs, error: msg.error });
      else finish({ kind: "ok", durationMs });
    });
    worker.on("error", (err) => {
      finish({
        kind: "worker-crash",
        durationMs: Date.now() - started,
        error: { name: err.name, message: err.message, stack: err.stack },
      });
    });
    worker.on("exit", (code) => {
      // Normal exit after "done" message is already handled; a non-zero exit
      // without a message means the worker crashed.
      if (!settled && code !== 0) {
        finish({
          kind: "worker-crash",
          durationMs: Date.now() - started,
          error: { name: "WorkerExit", message: "worker exited with code " + code },
        });
      }
    });
  });
}

/**
 * Execute all cases of all discovered files. Files are unblocked once all
 * files they depend on have finished; ready cases run with a concurrency
 * limit of `parallel`. Every case runs in its own worker, so a hung case
 * is terminated without affecting any other case.
 */
export async function runSuite(options: RunOptions): Promise<RunOutcome> {
  const { files, parallel, timeoutMs } = options;
  if (!Number.isInteger(parallel) || parallel < 1) {
    throw resourceExhausted("parallel must be a positive integer, got " + String(parallel));
  }
  const runId = options.runId ?? randomUUID();
  const emit = (ev: Omit<RunEvent, "ts" | "runId">) =>
    options.onEvent?.({ ts: new Date().toISOString(), runId, ...ev });

  const startedAt = new Date();
  emit({ event: "run-started", reason: files.length + " file(s), parallel=" + parallel + ", timeoutMs=" + timeoutMs });

  interface Task {
    file: DiscoveredFile;
    caseName: string;
  }
  const caseId = (t: Task) => t.file.relPath + "#" + t.caseName;

  // Remaining dependency counts per file.
  const pendingDeps = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const f of files) {
    pendingDeps.set(f.relPath, f.dependsOn.length);
    for (const dep of f.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(f.relPath);
      dependents.set(dep, list);
    }
  }

  const ready: Task[] = [];
  const enqueueFile = (relPath: string) => {
    const file = files.find((f) => f.relPath === relPath)!;
    for (const caseName of file.cases) {
      const task: Task = { file, caseName };
      ready.push(task);
      emit({ caseId: caseId(task), event: "case-scheduled", reason: "dependencies satisfied" });
    }
  };
  for (const f of files) if ((pendingDeps.get(f.relPath) ?? 0) === 0) enqueueFile(f.relPath);

  const outcomes = new Map<string, RawCaseOutcome>();
  let running = 0;
  let finishedFiles = 0;

  await new Promise<void>((resolveAll) => {
    const pump = () => {
      if (ready.length === 0 && running === 0) {
        resolveAll();
        return;
      }
      while (running < parallel && ready.length > 0) {
        const task = ready.shift()!;
        const id = caseId(task);
        running++;
        emit({ caseId: id, event: "case-running", reason: "worker spawned" });
        void runCase(task.file.absPath, task.caseName, timeoutMs).then((outcome) => {
          running--;
          outcomes.set(id, outcome);
          if (outcome.kind === "timeout") {
            emit({
              caseId: id,
              event: "case-timeout",
              reason: "exceeded timeoutMs=" + outcome.timeoutMs + " (actual " + outcome.durationMs + "ms), worker terminated",
            });
          } else if (outcome.kind === "worker-crash") {
            emit({ caseId: id, event: "case-worker-crash", reason: outcome.error.message });
          } else {
            emit({
              caseId: id,
              event: "case-finished",
              reason: outcome.kind === "ok" ? "completed without error" : "threw " + outcome.error.name + ": " + outcome.error.message,
            });
          }
          // Check whether the whole file is done to unblock dependents.
          const done = task.file.cases.every((c) => outcomes.has(task.file.relPath + "#" + c));
          if (done) {
            finishedFiles++;
            for (const dep of dependents.get(task.file.relPath) ?? []) {
              const left = (pendingDeps.get(dep) ?? 0) - 1;
              pendingDeps.set(dep, left);
              if (left === 0) enqueueFile(dep);
            }
          }
          pump();
        });
      }
    };
    pump();
    // Guard: no files at all.
    if (files.length === 0) resolveAll();
    void finishedFiles;
  });

  const finishedAt = new Date();
  emit({ event: "run-finished", reason: outcomes.size + " case(s) executed" });
  return {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    outcomes,
  };
}
