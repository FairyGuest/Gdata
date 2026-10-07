// Error taxonomy shared across modules. Every failure carries a stable
// category so callers can distinguish input errors, state conflicts,
// resource exhaustion and computation failures.

export const ERROR_CATEGORIES = [
  "INPUT_ERROR",         // malformed request / invalid layer structure
  "NOT_FOUND",           // referenced run or resource does not exist
  "STATE_CONFLICT",      // request conflicts with persisted state
  "RESOURCE_EXHAUSTED",  // payload/depth/size limits exceeded
  "COMPUTATION_FAILURE", // unexpected internal failure
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const CATEGORY_HTTP_STATUS: Record<ErrorCategory, number> = {
  INPUT_ERROR: 400,
  NOT_FOUND: 404,
  STATE_CONFLICT: 409,
  RESOURCE_EXHAUSTED: 413,
  COMPUTATION_FAILURE: 500,
};

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly detail: Record<string, unknown>;

  constructor(category: ErrorCategory, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "AppError";
    this.category = category;
    this.detail = detail;
  }

  get httpStatus(): number {
    return CATEGORY_HTTP_STATUS[this.category];
  }

  toJSON() {
    return { error: { category: this.category, message: this.message, detail: this.detail } };
  }
}

export function inputError(message: string, detail: Record<string, unknown> = {}): AppError {
  return new AppError("INPUT_ERROR", message, detail);
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError("COMPUTATION_FAILURE", message);
}
