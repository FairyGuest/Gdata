/**
 * Error taxonomy shared across all module boundaries.
 * Every failure carries a stable code so callers can distinguish
 * input errors, state conflicts, resource exhaustion and computation failures.
 */

export type ErrorCategory = "input" | "state" | "resource" | "computation" | "internal";

export class FactoryError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: string, message: string, category: ErrorCategory, httpStatus: number, details?: unknown) {
    super(message);
    this.name = "FactoryError";
    this.code = code;
    this.category = category;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/** Malformed request body / unknown type / wrong field shapes. */
export class ValidationError extends FactoryError {
  constructor(message: string, details?: unknown) {
    super("SCHEMA_VALIDATION", message, "input", 400, details);
  }
}

/** Constraints contradict each other (e.g. min > max, empty enum). */
export class ConstraintConflictError extends FactoryError {
  constructor(message: string, details?: unknown) {
    super("CONSTRAINT_CONFLICT", message, "input", 422, details);
  }
}

/** Referenced resource does not exist. */
export class NotFoundError extends FactoryError {
  constructor(message: string, details?: unknown) {
    super("NOT_FOUND", message, "state", 404, details);
  }
}

/** Request conflicts with persisted state (e.g. duplicate dataset id). */
export class StateConflictError extends FactoryError {
  constructor(message: string, details?: unknown) {
    super("STATE_CONFLICT", message, "state", 409, details);
  }
}

/** Requested work exceeds configured limits (rows, depth, array size). */
export class ResourceExhaustedError extends FactoryError {
  constructor(message: string, details?: unknown) {
    super("RESOURCE_EXHAUSTED", message, "resource", 413, details);
  }
}

/** Generation could not be completed (e.g. unsatisfiable regex after retries). */
export class ComputationError extends FactoryError {
  constructor(message: string, details?: unknown) {
    super("GENERATION_FAILED", message, "computation", 500, details);
  }
}

export function toErrorBody(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof FactoryError) {
    return {
      status: err.httpStatus,
      body: { error: { code: err.code, category: err.category, message: err.message, details: err.details ?? null } },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: { code: "INTERNAL", category: "internal", message, details: null } } };
}
