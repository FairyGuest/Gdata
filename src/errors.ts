// Error taxonomy shared across all layers.
// Every failure surfaced by the service is one of these categories; nothing
// unexpected is ever reported as success.

export type ErrorCode =
  | "INPUT_ERROR"        // malformed contract / invalid argument (400)
  | "PORT_CONFLICT"      // preferred port already occupied by an active lease (409)
  | "LEASE_NOT_FOUND"    // unknown lease id (404)
  | "LEASE_NOT_ACTIVE"   // lease is in a terminal state: expired or released (409)
  | "RESOURCE_EXHAUSTED" // no free port left in the configured range (503)
  | "INTERNAL_ERROR";    // unexpected computation/persistence failure (500)

export class AppError extends Error {
  code: ErrorCode;
  httpStatus: number;
  details?: unknown;
  runId?: string;
  constructor(code: ErrorCode, httpStatus: number, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export function inputError(message: string, details?: unknown): AppError {
  return new AppError("INPUT_ERROR", 400, message, details);
}
export function portConflict(message: string, details?: unknown): AppError {
  return new AppError("PORT_CONFLICT", 409, message, details);
}
export function leaseNotFound(leaseId: string): AppError {
  return new AppError("LEASE_NOT_FOUND", 404, "lease not found: " + leaseId, { leaseId });
}
export function leaseNotActive(leaseId: string, status: string): AppError {
  return new AppError("LEASE_NOT_ACTIVE", 409,
    "lease " + leaseId + " is not active (status=" + status + ")", { leaseId, status });
}
export function resourceExhausted(message: string, details?: unknown): AppError {
  return new AppError("RESOURCE_EXHAUSTED", 503, message, details);
}
export function internalError(message: string, details?: unknown): AppError {
  return new AppError("INTERNAL_ERROR", 500, message, details);
}

export function toErrorBody(err: unknown): { httpStatus: number; body: unknown } {
  if (err instanceof AppError) {
    return {
      httpStatus: err.httpStatus,
      body: { error: { code: err.code, message: err.message, details: err.details ?? null, runId: err.runId ?? null } },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    httpStatus: 500,
    body: { error: { code: "INTERNAL_ERROR", message: message, details: null, runId: null } },
  };
}

