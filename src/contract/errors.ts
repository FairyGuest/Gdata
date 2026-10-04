export type ErrorKind =
  | "VALIDATION"
  | "STATE_CONFLICT"
  | "RESOURCE_EXHAUSTED"
  | "COMPUTATION_FAILURE"
  | "INTERNAL";

export class AuditError extends Error {
  readonly kind: ErrorKind;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(kind: ErrorKind, message: string, statusCode: number, details?: unknown) {
    super(message);
    this.name = "AuditError";
    this.kind = kind;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function validationError(message: string, details?: unknown): AuditError {
  return new AuditError("VALIDATION", message, 400, details);
}

export function stateConflict(message: string, details?: unknown): AuditError {
  return new AuditError("STATE_CONFLICT", message, 409, details);
}

export function resourceExhausted(message: string, details?: unknown): AuditError {
  return new AuditError("RESOURCE_EXHAUSTED", message, 507, details);
}

export function computationFailure(message: string, details?: unknown): AuditError {
  return new AuditError("COMPUTATION_FAILURE", message, 500, details);
}

export function internalError(message: string, details?: unknown): AuditError {
  return new AuditError("INTERNAL", message, 500, details);
}

export function isAuditError(err: unknown): err is AuditError {
  return err instanceof AuditError;
}
