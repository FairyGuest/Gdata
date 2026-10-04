/** Error taxonomy shared across contract / kernel / state / diag layers. */

export type ErrorKind = "input" | "conflict" | "resource" | "internal";

export class AppError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    public readonly statusCode: number,
    public readonly reason: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 422 - malformed params, unknown collection/token, token not in collection. */
export class InputError extends AppError {
  constructor(reason: string, message: string, details?: Record<string, unknown>) {
    super("input", 422, reason, message, details);
  }
}

/** 409 - state conflicts: insufficient balance, non-creator, not owner, race lost. */
export class ConflictError extends AppError {
  constructor(reason: string, message: string, details?: Record<string, unknown>) {
    super("conflict", 409, reason, message, details);
  }
}

/** 503 - storage unavailable, lock wait timeout. */
export class ResourceError extends AppError {
  constructor(reason: string, message: string, details?: Record<string, unknown>) {
    super("resource", 503, reason, message, details);
  }
}

/** 500 - conservation assertion or other computation failure. */
export class ConservationError extends AppError {
  constructor(reason: string, message: string, details?: Record<string, unknown>) {
    super("internal", 500, reason, message, details);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
