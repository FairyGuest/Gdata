export type ErrorCategory = "input" | "conflict" | "unavailable" | "compute";

export type ErrorReason =
  | "malformed_body"
  | "missing_field"
  | "price_not_positive_integer"
  | "unknown_collection"
  | "unknown_token"
  | "unknown_user"
  | "unknown_bid"
  | "token_not_in_collection"
  | "insufficient_balance"
  | "bid_already_filled"
  | "bid_already_cancelled"
  | "not_bid_owner"
  | "seller_does_not_own_token"
  | "commit_race_lost"
  | "storage_unavailable"
  | "lock_timeout"
  | "invariant_violation"
  | "unexpected_error";

export const ERROR_STATUS: Readonly<Record<ErrorCategory, number>> = Object.freeze({
  input: 422,
  conflict: 409,
  unavailable: 503,
  compute: 500,
});

export interface ErrorDetails {
  readonly [key: string]: unknown;
}

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly reason: ErrorReason;
  readonly statusCode: number;
  readonly details?: ErrorDetails;
  runId?: string;

  constructor(category: ErrorCategory, reason: ErrorReason, message: string, details?: ErrorDetails) {
    super(message);
    this.name = "AppError";
    this.category = category;
    this.reason = reason;
    this.statusCode = ERROR_STATUS[category];
    if (details !== undefined) this.details = details;
  }
}

export const inputError = (reason: ErrorReason, message: string, details?: ErrorDetails): AppError =>
  new AppError("input", reason, message, details);

export const conflictError = (reason: ErrorReason, message: string, details?: ErrorDetails): AppError =>
  new AppError("conflict", reason, message, details);

export const unavailableError = (reason: ErrorReason, message: string, details?: ErrorDetails): AppError =>
  new AppError("unavailable", reason, message, details);

export const computeError = (reason: ErrorReason, message: string, details?: ErrorDetails): AppError =>
  new AppError("compute", reason, message, details);

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
