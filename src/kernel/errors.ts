export type ErrorReason =
  | "invalid_body"
  | "invalid_field"
  | "unsupported_type"
  | "event_gap"
  | "duplicate_event"
  | "invalid_transition"
  | "db_busy"
  | "db_full"
  | "not_found"
  | "internal_error";

export interface ErrorBody {
  error: true;
  reason: ErrorReason;
  message: string;
  runId?: string;
  detail?: unknown;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly reason: ErrorReason;
  readonly detail?: unknown;

  constructor(statusCode: number, reason: ErrorReason, message: string, detail?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.reason = reason;
    this.detail = detail;
  }

  toBody(runId?: string): ErrorBody {
    const body: ErrorBody = { error: true, reason: this.reason, message: this.message };
    if (runId) body.runId = runId;
    if (this.detail !== undefined) body.detail = this.detail;
    return body;
  }
}

export const inputError = (reason: ErrorReason, message: string, detail?: unknown) =>
  new AppError(422, reason, message, detail);
export const conflict = (reason: ErrorReason, message: string, detail?: unknown) =>
  new AppError(409, reason, message, detail);
export const unavailable = (reason: ErrorReason, message: string, detail?: unknown) =>
  new AppError(503, reason, message, detail);
export const internal = (message: string, detail?: unknown) =>
  new AppError(500, "internal_error", message, detail);

