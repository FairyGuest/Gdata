/**
 * Error contract shared by all layers.
 *
 * Categories map to HTTP semantics and let callers distinguish:
 *  - input:    caller sent a malformed/invalid request (contract parsing failure)
 *  - state:    request conflicts with persisted state (missing key, expired key, bad transition)
 *  - resource: a quota/limit was exhausted
 *  - internal: unexpected computation/persistence failure
 */
export type ErrorCategory = "input" | "state" | "resource" | "internal";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "KEY_NOT_FOUND"
  | "KEY_EXPIRED"
  | "ROTATION_CONFLICT"
  | "QUOTA_EXHAUSTED"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    category: ErrorCategory,
    httpStatus: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.category = category;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export const validationError = (message: string, details?: Record<string, unknown>) =>
  new AppError("VALIDATION_ERROR", "input", 400, message, details);

export const keyNotFound = (key: string) =>
  new AppError("KEY_NOT_FOUND", "state", 404, `API key not found: ${key}`, { key });

export const keyExpired = (key: string, graceUntil: number, now: number) =>
  new AppError(
    "KEY_EXPIRED",
    "state",
    410,
    `API key ${key} was rotated and its grace period ended at ${graceUntil} (now=${now})`,
    { key, graceUntil, now },
  );

export const rotationConflict = (key: string, reason: string) =>
  new AppError("ROTATION_CONFLICT", "state", 409, `Cannot rotate key ${key}: ${reason}`, {
    key,
    reason,
  });

export const quotaExhausted = (
  tier: string,
  scopeId: string,
  requested: number,
  remaining: number,
) =>
  new AppError(
    "QUOTA_EXHAUSTED",
    "resource",
    429,
    `Quota exhausted at ${tier} scope ${scopeId}: requested ${requested}, remaining ${remaining}`,
    { tier, scopeId, requested, remaining },
  );

export const internalError = (message: string, details?: Record<string, unknown>) =>
  new AppError("INTERNAL_ERROR", "internal", 500, message, details);

export interface ErrorBody {
  error: {
    code: ErrorCode;
    category: ErrorCategory;
    message: string;
    details?: Record<string, unknown>;
  };
}

export function toErrorBody(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof AppError) {
    return {
      status: err.httpStatus,
      body: {
        error: {
          code: err.code,
          category: err.category,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    body: {
      error: { code: "INTERNAL_ERROR", category: "internal", message },
    },
  };
}
