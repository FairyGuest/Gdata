import type {
  CompareRequest,
  CompareResponse,
  FieldDiff,
  JsonValue,
} from "../contract/types.ts";
import { structuredDiff } from "./diff.ts";
import type { SnapshotStore } from "../store/store.ts";
import { stateConflict, resourceExhausted, computeFailure } from "../diagnostics/errors.ts";
import type { Logger } from "../diagnostics/logger.ts";

export interface EngineOptions {
  maxSnapshots: number;
}

// Execution kernel: orchestrates load -> diff -> decide -> persist.
// Emits structured logs with runId, intermediate state and decision reasons.
export class SnapshotEngine {
  private readonly store: SnapshotStore;
  private readonly logger: Logger;
  private readonly opts: EngineOptions;
  constructor(store: SnapshotStore, logger: Logger, opts: EngineOptions) {
    this.store = store;
    this.logger = logger;
    this.opts = opts;
  }

  compare(req: CompareRequest, runId: string): CompareResponse {
    const ignored = req.ignorePaths ?? [];
    this.logger.info(runId, "load", "loading stored snapshot", { name: req.name });
    const existing = this.store.get(req.name);
    this.logger.info(runId, "load", existing ? "snapshot found" : "no snapshot stored", {
      name: req.name,
      exists: existing !== null,
    });

    if (req.update) {
      if (existing === null) {
        this.store.put(req.name, req.data);
        this.logger.info(runId, "decision", "update requested, no prior snapshot; created", { name: req.name });
        return this.respond(runId, req.name, "created", [], ignored, "update requested but no snapshot existed; created new snapshot");
      }
      this.store.put(req.name, req.data);
      this.logger.info(runId, "decision", "snapshot force-updated", { name: req.name });
      return this.respond(runId, req.name, "updated", [], ignored, "snapshot force-updated with incoming data");
    }

    if (existing === null) {
      const count = this.store.count();
      if (count >= this.opts.maxSnapshots) {
        throw resourceExhausted("SNAPSHOT_LIMIT", "snapshot store is full (" + count + "/" + this.opts.maxSnapshots + ")");
      }
      this.store.put(req.name, req.data);
      this.logger.info(runId, "decision", "first call: snapshot auto-created", { name: req.name, snapshotCount: count + 1 });
      return this.respond(runId, req.name, "created", [], ignored, "no existing snapshot; auto-created on first call");
    }

    let diffs: FieldDiff[];
    try {
      diffs = structuredDiff(existing.data, req.data, ignored);
    } catch (e) {
      throw computeFailure("DIFF_FAILED", "structured diff failed: " + (e instanceof Error ? e.message : String(e)));
    }
    this.logger.info(runId, "diff", "structured diff computed", {
      name: req.name,
      diffCount: diffs.length,
      ignoredPaths: ignored,
    });

    if (diffs.length === 0) {
      this.logger.info(runId, "decision", "snapshot matches", { name: req.name });
      return this.respond(runId, req.name, "passed", [], ignored, "incoming data matches stored snapshot (after ignored paths)");
    }
    this.logger.info(runId, "decision", "snapshot mismatch", { name: req.name, diffCount: diffs.length });
    return this.respond(runId, req.name, "failed", diffs, ignored, diffs.length + " field-level difference(s) detected");
  }

  // Explicit create-only operation: conflicts when the snapshot already exists.
  create(name: string, data: JsonValue, runId: string): CompareResponse {
    const existing = this.store.get(name);
    if (existing !== null) {
      throw stateConflict("SNAPSHOT_EXISTS", "snapshot '" + name + "' already exists");
    }
    const count = this.store.count();
    if (count >= this.opts.maxSnapshots) {
      throw resourceExhausted("SNAPSHOT_LIMIT", "snapshot store is full (" + count + "/" + this.opts.maxSnapshots + ")");
    }
    this.store.put(name, data);
    this.logger.info(runId, "decision", "snapshot created explicitly", { name });
    return this.respond(runId, name, "created", [], [], "snapshot created explicitly");
  }

  get(name: string, runId: string) {
    const rec = this.store.get(name);
    if (rec === null) {
      throw stateConflict("SNAPSHOT_NOT_FOUND", "snapshot '" + name + "' does not exist");
    }
    this.logger.info(runId, "load", "snapshot retrieved", { name });
    return rec;
  }

  private respond(runId: string, name: string, status: CompareResponse["status"], diffs: FieldDiff[], ignoredPaths: string[], reason: string): CompareResponse {
    return { runId, name, status, diffs, ignoredPaths, reason };
  }
}
