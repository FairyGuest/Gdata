import { AppError, conflict, inputError, internal } from "../kernel/errors.ts";
import { parseEventBody } from "../contract/parser.ts";
import type { IndexerService } from "../kernel/indexer.ts";
import type { EventStore } from "../state/store.ts";
import type { HttpApp, HttpContext } from "./http.ts";

export function registerRoutes(app: HttpApp, indexer: IndexerService, store: EventStore): void {
  app.add("POST", "/events", (ctx) => withDiagnostics(ctx, store, () => {
    const event = parseEventBody(ctx.body);
    const result = indexer.ingest(event);
    return {
      status: result.status,
      seq: event.seq,
      appliedSeq: result.appliedSeq,
      commitSeq: result.commitSeq,
      fingerprint: result.fingerprint,
    };
  }));

  app.add("GET", "/state", () => {
    const projection = indexer.snapshot();
    return {
      appliedSeq: projection.appliedSeq,
      ownership: projection.ownership,
      stats: {
        volume: projection.volume,
        floor: projection.floor,
        lastSale: projection.lastSale,
      },
    };
  });

  app.add("POST", "/rebuild", (ctx) => withDiagnostics(ctx, store, () => {
    const body = (ctx.body ?? {}) as { toSeq?: unknown };
    if (typeof body.toSeq !== "number" || !Number.isInteger(body.toSeq) || body.toSeq < 0) {
      throw inputError("invalid_field", "body.toSeq must be a non-negative integer", { got: body.toSeq });
    }
    const result = indexer.rebuild(body.toSeq);
    return {
      appliedSeq: result.appliedSeq,
      ownership: result.projection.ownership,
      stats: {
        volume: result.projection.volume,
        floor: result.projection.floor,
        lastSale: result.projection.lastSale,
      },
    };
  }));

  app.add("GET", "/diag/rejections", () => ({ rejections: store.listRejections(50) }));

  app.add("GET", "/health", (ctx) => ({ ok: true, runId: ctx.config.runId }));
}

function withDiagnostics(ctx: HttpContext, store: EventStore, fn: () => unknown): unknown {
  try {
    return fn();
  } catch (err) {
    const normalized = toAppError(err);
    store.logRejection({
      runId: ctx.config.runId,
      reason: normalized.reason,
      status: normalized.statusCode,
      seq: extractSeq(ctx.body),
      message: normalized.message,
      detail: normalized.detail,
      createdAt: new Date().toISOString(),
    });
    throw normalized;
  }
}

function extractSeq(body: unknown): number | null {
  if (body && typeof body === "object" && "seq" in body) {
    const seq = (body as { seq?: unknown }).seq;
    return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
  }
  return null;
}

function isShapedError(err: unknown): err is { statusCode: number; reason: string; message: string; detail?: unknown } {
  return !!err && typeof err === "object" && "statusCode" in err && "reason" in err;
}

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (isShapedError(err)) {
    if (err.reason === "event_gap" || err.reason === "duplicate_event" || err.reason === "invalid_transition") {
      return conflict(err.reason, err.message, err.detail);
    }
    if (err.reason === "invalid_field") {
      return inputError(err.reason, err.message, err.detail);
    }
    return internal(err.message, err.detail);
  }
  const message = err instanceof Error ? err.message : String(err);
  return internal("unexpected computation failure", { cause: message });
}

