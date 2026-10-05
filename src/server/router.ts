import type { CompareResponse, ErrorBody, SnapshotRecord } from "../contract/types.ts";
import { ERROR_HTTP_STATUS } from "../contract/types.ts";
import { parseCompareRequest, parseNameParam } from "../contract/validate.ts";
import { SnapshotEngine } from "../core/engine.ts";
import { toServiceError } from "../diagnostics/errors.ts";
import type { Logger } from "../diagnostics/logger.ts";

export interface RouteResult {
  status: number;
  body: CompareResponse | SnapshotRecord | ErrorBody | { status: string };
}

// Framework-agnostic route handlers. Both the node:http adapter and the
// Fastify adapter delegate here, so behavior (and error semantics) is identical.
export class Router {
  private readonly engine: SnapshotEngine;
  private readonly logger: Logger;
  constructor(engine: SnapshotEngine, logger: Logger) {
    this.engine = engine;
    this.logger = logger;
  }

  health(runId: string): RouteResult {
    return { status: 200, body: { status: "ok" } };
  }

  compare(rawBody: unknown): RouteResult {
    const runId = this.logger.newRunId();
    try {
      const req = parseCompareRequest(rawBody);
      this.logger.info(runId, "validate", "request validated", { name: req.name, update: req.update, ignorePaths: req.ignorePaths });
      const res = this.engine.compare(req, runId);
      // mismatch is a normal, successful evaluation: HTTP 200 with status "failed"
      return { status: 200, body: res };
    } catch (e) {
      return this.errorResult(runId, "compare", e);
    }
  }

  create(rawBody: unknown): RouteResult {
    const runId = this.logger.newRunId();
    try {
      const req = parseCompareRequest(rawBody);
      const res = this.engine.create(req.name, req.data, runId);
      return { status: 201, body: res };
    } catch (e) {
      return this.errorResult(runId, "create", e);
    }
  }

  getSnapshot(name: unknown): RouteResult {
    const runId = this.logger.newRunId();
    try {
      const rec = this.engine.get(parseNameParam(name), runId);
      return { status: 200, body: rec };
    } catch (e) {
      return this.errorResult(runId, "get", e);
    }
  }

  private errorResult(runId: string, stage: string, e: unknown): RouteResult {
    const err = toServiceError(e);
    this.logger.error(runId, stage, err.message, { category: err.category, code: err.code });
    const body: ErrorBody = { runId, error: { category: err.category, code: err.code, message: err.message } };
    return { status: ERROR_HTTP_STATUS[err.category], body };
  }
}
