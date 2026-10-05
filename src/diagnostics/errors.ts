import type { ErrorCategory } from "../contract/types.ts";

// ServiceError is the single error type crossing module boundaries.
// Every failure must carry a category so callers can distinguish
// input errors, state conflicts, resource exhaustion and compute failures.
export class ServiceError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  constructor(category: ErrorCategory, code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.category = category;
    this.code = code;
  }
}

export const inputError = (code: string, message: string) =>
  new ServiceError("INPUT_ERROR", code, message);
export const stateConflict = (code: string, message: string) =>
  new ServiceError("STATE_CONFLICT", code, message);
export const resourceExhausted = (code: string, message: string) =>
  new ServiceError("RESOURCE_EXHAUSTED", code, message);
export const computeFailure = (code: string, message: string) =>
  new ServiceError("COMPUTE_FAILURE", code, message);

export const isServiceError = (e: unknown): e is ServiceError => e instanceof ServiceError;

// Unknown errors are never silently swallowed: they map to COMPUTE_FAILURE/INTERNAL.
export function toServiceError(e: unknown): ServiceError {
  if (isServiceError(e)) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return computeFailure("INTERNAL", msg);
}
