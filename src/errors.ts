// Error taxonomy. Every failure surfaced by the service carries one of these
// codes so that input errors, state conflicts, resource exhaustion and
// calculation failures are distinguishable by clients and in logs.

export type ErrorCode =
  | "INPUT_ERROR"         // malformed/invalid request payload or config (HTTP 400)
  | "NOT_FOUND"           // referenced run does not exist (HTTP 404)
  | "STATE_CONFLICT"      // valid request, invalid state e.g. run not finished (HTTP 409)
  | "RESOURCE_EXHAUSTED"  // too many concurrent runs etc. (HTTP 429)
  | "CALCULATION_FAILED"  // statistics computation failed (HTTP 500)
  | "INTERNAL_ERROR";     // anything unexpected (HTTP 500)

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  INPUT_ERROR: 400,
  NOT_FOUND: 404,
  STATE_CONFLICT: 409,
  RESOURCE_EXHAUSTED: 429,
  CALCULATION_FAILED: 500,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export function toErrorBody(err: unknown): { status: number; body: { error: { code: string; message: string; details?: unknown } } } {
  if (err instanceof AppError) {
    return { status: err.httpStatus, body: { error: { code: err.code, message: err.message, details: err.details } } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: { code: "INTERNAL_ERROR", message } } };
}
