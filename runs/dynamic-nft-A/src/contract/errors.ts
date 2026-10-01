export type ErrorCategory = "input" | "conflict" | "exhausted" | "compute";

export const ERROR_STATUS: Record<ErrorCategory, number> = {
  input: 422,
  conflict: 409,
  exhausted: 503,
  compute: 500,
};

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly reason: string;
  readonly detail: Record<string, unknown>;

  constructor(category: ErrorCategory, reason: string, detail: Record<string, unknown> = {}) {
    super(reason);
    this.category = category;
    this.reason = reason;
    this.detail = detail;
  }

  get status(): number {
    return ERROR_STATUS[this.category];
  }
}

export function invalid(reason: string, detail: Record<string, unknown> = {}): AppError {
  return new AppError("input", reason, detail);
}

export function conflict(reason: string, detail: Record<string, unknown> = {}): AppError {
  return new AppError("conflict", reason, detail);
}

export function exhausted(reason: string, detail: Record<string, unknown> = {}): AppError {
  return new AppError("exhausted", reason, detail);
}

export function computeFailure(reason: string, detail: Record<string, unknown> = {}): AppError {
  return new AppError("compute", reason, detail);
}
