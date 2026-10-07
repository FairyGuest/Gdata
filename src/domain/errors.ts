export type ErrorCode =
  | "VALIDATION_ERROR"
  | "MISSING_SECRETS"
  | "NOT_FOUND"
  | "CONFLICT_REFERENCED"
  | "CONFLICT_DUPLICATE"
  | "INTERNAL_ERROR";

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  MISSING_SECRETS: 422,
  NOT_FOUND: 404,
  CONFLICT_REFERENCED: 409,
  CONFLICT_DUPLICATE: 409,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
  get httpStatus(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
