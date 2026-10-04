import type { ErrorCategory } from "./types.ts";

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly detail?: unknown;

  constructor(category: ErrorCategory, message: string, detail?: unknown) {
    super(message);
    this.name = "AppError";
    this.category = category;
    this.detail = detail;
  }
}

export const inputError = (msg: string, detail?: unknown) =>
  new AppError("INPUT_ERROR", msg, detail);
export const stateConflict = (msg: string, detail?: unknown) =>
  new AppError("STATE_CONFLICT", msg, detail);
export const resourceExhausted = (msg: string, detail?: unknown) =>
  new AppError("RESOURCE_EXHAUSTED", msg, detail);
export const internalError = (msg: string, detail?: unknown) =>
  new AppError("INTERNAL_ERROR", msg, detail);

