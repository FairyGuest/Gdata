// Error contract shared across all layers.
// Every failure surfaced by the execution kernel is a LifecycleError with a
// stable machine-readable code. HTTP mapping lives in src/http/routes.ts.

export const ErrorCodes = {
  UNKNOWN_PARAM: 'UNKNOWN_PARAM',
  PARAM_TYPE_MISMATCH: 'PARAM_TYPE_MISMATCH',
  INVALID_TTL: 'INVALID_TTL',
  INVALID_REQUEST: 'INVALID_REQUEST',
  BRANCH_PARAM_CONFLICT: 'BRANCH_PARAM_CONFLICT',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  ENV_NOT_FOUND: 'ENV_NOT_FOUND',
  DELETE_LOCKED: 'DELETE_LOCKED',
  FORCE_REASON_REQUIRED: 'FORCE_REASON_REQUIRED',
  INVALID_STATE: 'INVALID_STATE',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class LifecycleError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export function isLifecycleError(err: unknown): err is LifecycleError {
  return err instanceof LifecycleError;
}

