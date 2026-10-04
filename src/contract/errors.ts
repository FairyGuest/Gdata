export type ErrorCode =
  | "INPUT_VALIDATION"
  | "SEQUENCE_CONFLICT"
  | "INTEGRITY_TAMPER"
  | "SEQUENCE_GAP"
  | "RESOURCE_EXHAUSTED"
  | "STORAGE_FAILURE"
  | "HASH_COMPUTE_FAILURE";

export class AuditError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AuditError";
    this.code = code;
    this.details = details;
  }
}

export const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  INPUT_VALIDATION: 400,
  SEQUENCE_CONFLICT: 409,
  INTEGRITY_TAMPER: 422,
  SEQUENCE_GAP: 422,
  RESOURCE_EXHAUSTED: 413,
  STORAGE_FAILURE: 500,
  HASH_COMPUTE_FAILURE: 500,
};

