export type ErrorCategory =
  | "INPUT_ERROR"
  | "STATE_CONFLICT"
  | "RESOURCE_EXHAUSTED"
  | "COMPUTE_FAILURE";

const HTTP_STATUS: Record<ErrorCategory, number> = {
  INPUT_ERROR: 400,
  STATE_CONFLICT: 409,
  RESOURCE_EXHAUSTED: 413,
  COMPUTE_FAILURE: 500,
};

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly httpStatus: number;
  readonly detail?: unknown;

  constructor(category: ErrorCategory, message: string, detail?: unknown) {
    super(message);
    this.name = "AppError";
    this.category = category;
    this.httpStatus = HTTP_STATUS[category];
    if (detail !== undefined) this.detail = detail;
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError("COMPUTE_FAILURE", message);
}
