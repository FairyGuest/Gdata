import { randomUUID } from "node:crypto";
import { AppError } from "../contract/errors.ts";
import type {
  CompareRequest,
  CompareResult,
  DiffEntry,
  JsonValue,
  RunRecord,
} from "../contract/types.ts";
import { diffValues } from "./diff.ts";
import { isIgnored } from "./ignore.ts";
import { deserializeSnapshot, stableSerialize } from "./serialize.ts";

export interface Limits {
  maxDiffEntries: number;
  maxSerializedBytes: number;
}

export interface StoredSnapshot {
  key: string;
  serialized: string;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotStore {
  getSnapshot(key: string): StoredSnapshot | null;
  putSnapshot(key: string, serialized: string): { created: boolean };
  deleteSnapshot(key: string): boolean;
  recordRun(record: RunRecord): void;
  listRuns(key?: string): RunRecord[];
  getRun(runId: string): RunRecord | null;
}

export type LogLevel = "info" | "warn" | "error";
export type Logger = (level: LogLevel, event: string, fields: Record<string, unknown>) => void;

const noopLogger: Logger = () => {};

export class SnapshotEngine {
  private readonly store: SnapshotStore;
  private readonly limits: Limits;
  private readonly log: Logger;

  constructor(store: SnapshotStore, limits: Limits, log: Logger = noopLogger) {
    this.store = store;
    this.limits = limits;
    this.log = log;
  }

  compare(req: CompareRequest): CompareResult {
    const runId = randomUUID();
    const serialized = stableSerialize(req.data);
    this.assertSize(serialized, runId, req.key);
    const ignorePaths = req.ignorePaths ?? [];

    const existing = this.store.getSnapshot(req.key);

    if (!existing) {
      if (req.createIfMissing === false) {
        const err = new AppError("STATE_CONFLICT", "snapshot does not exist and createIfMissing=false", {
          key: req.key,
        });
        this.finish(runId, req.key, "compare", "conflict", err.message, { runId });
        throw err;
      }
      this.store.putSnapshot(req.key, serialized);
      const result: CompareResult = {
        runId, key: req.key, status: "created",
        reason: "no existing snapshot; stored current payload as baseline",
        diff: [], diffTruncated: false, ignoredPaths: ignorePaths,
      };
      this.finish(runId, req.key, "compare", "created", result.reason, { serializedBytes: serialized.length });
      return result;
    }

    const before = deserializeSnapshot(existing.serialized, req.key);
    const raw = diffValues(before, req.data, this.limits.maxDiffEntries);
    const diff = raw.entries.filter((e) => !isIgnored(ignorePaths, e.path));

    if (diff.length === 0) {
      const result: CompareResult = {
        runId, key: req.key, status: "passed",
        reason: raw.entries.length > 0
          ? "differences exist only on ignored paths"
          : "payload matches stored snapshot",
        diff: [], diffTruncated: false, ignoredPaths: ignorePaths,
      };
      this.finish(runId, req.key, "compare", "passed", result.reason, {
        rawDiffCount: raw.entries.length, ignoredDiffCount: raw.entries.length,
      });
      return result;
    }

    if (req.updateOnMismatch) {
      this.store.putSnapshot(req.key, serialized);
      const result: CompareResult = {
        runId, key: req.key, status: "updated",
        reason: "mismatch detected; snapshot updated because updateOnMismatch=true",
        diff, diffTruncated: raw.truncated, ignoredPaths: ignorePaths,
      };
      this.finish(runId, req.key, "compare", "updated", result.reason, { diffCount: diff.length });
      return result;
    }

    const result: CompareResult = {
      runId, key: req.key, status: "failed",
      reason: diff.length + " field difference(s) detected",
      diff, diffTruncated: raw.truncated, ignoredPaths: ignorePaths,
    };
    this.finish(runId, req.key, "compare", "failed", result.reason, {
      diffCount: diff.length, diffTruncated: raw.truncated,
      firstPaths: diff.slice(0, 5).map((d: DiffEntry) => d.path),
    });
    return result;
  }

  forceUpdate(req: { key: string; data: JsonValue }): CompareResult {
    const runId = randomUUID();
    const serialized = stableSerialize(req.data);
    this.assertSize(serialized, runId, req.key);
    const existing = this.store.getSnapshot(req.key);
    if (!existing) {
      const err = new AppError("STATE_CONFLICT", "cannot force-update: snapshot does not exist", {
        key: req.key,
      });
      this.finish(runId, req.key, "update", "conflict", err.message, {});
      throw err;
    }
    this.store.putSnapshot(req.key, serialized);
    const result: CompareResult = {
      runId, key: req.key, status: "updated",
      reason: "snapshot force-updated",
      diff: [], diffTruncated: false, ignoredPaths: [],
    };
    this.finish(runId, req.key, "update", "updated", result.reason, {});
    return result;
  }

  getSnapshot(key: string): StoredSnapshot {
    const snap = this.store.getSnapshot(key);
    if (!snap) throw new AppError("STATE_CONFLICT", "snapshot not found", { key });
    return snap;
  }

  deleteSnapshot(key: string): void {
    const runId = randomUUID();
    const removed = this.store.deleteSnapshot(key);
    if (!removed) {
      const err = new AppError("STATE_CONFLICT", "cannot delete: snapshot does not exist", { key });
      this.finish(runId, key, "delete", "conflict", err.message, {});
      throw err;
    }
    this.finish(runId, key, "delete", "deleted", "snapshot deleted", {});
  }

  listRuns(key?: string): RunRecord[] {
    return this.store.listRuns(key);
  }

  getRun(runId: string): RunRecord {
    const run = this.store.getRun(runId);
    if (!run) throw new AppError("STATE_CONFLICT", "run not found", { runId });
    return run;
  }

  private assertSize(serialized: string, runId: string, key: string): void {
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > this.limits.maxSerializedBytes) {
      const err = new AppError("RESOURCE_EXHAUSTED", "serialized payload exceeds limit", {
        key, bytes, limit: this.limits.maxSerializedBytes,
      });
      this.finish(runId, key, "compare", "rejected", err.message, { bytes });
      throw err;
    }
  }

  private finish(
    runId: string, key: string, action: string, status: string,
    reason: string, detail: unknown,
  ): void {
    const record: RunRecord = {
      runId, key, action, status, reason, detail,
      createdAt: new Date().toISOString(),
    };
    try {
      this.store.recordRun(record);
    } catch (err) {
      this.log("error", "run_record_failed", {
        runId, cause: err instanceof Error ? err.message : String(err),
      });
    }
    this.log(status === "failed" || status === "conflict" || status === "rejected" ? "warn" : "info",
      "snapshot_run", { runId, key, action, status, reason });
  }
}
