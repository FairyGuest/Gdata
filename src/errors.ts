/**
 * Error taxonomy shared across all layers.
 * Every failure the service reports carries one of these codes so that
 * input errors, state conflicts, resource exhaustion and computation
 * failures are distinguishable to callers and in diagnostic logs.
 */
export const ErrorCode = {
  /** Request payload failed contract parsing (wrong types, missing fields). */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** Token string is not a well-formed JWT. */
  TOKEN_MALFORMED: 'TOKEN_MALFORMED',
  /** JWT signature or algorithm check failed. */
  TOKEN_INVALID_SIGNATURE: 'TOKEN_INVALID_SIGNATURE',
  /** Token is past its expiry at the current (virtual) time. */
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  /** Token was explicitly revoked. */
  TOKEN_REVOKED: 'TOKEN_REVOKED',
  /** Token was rotated: a refresh already replaced it. */
  TOKEN_ROTATED: 'TOKEN_ROTATED',
  /** A state transition lost a race or violates lifecycle rules. */
  STATE_CONFLICT: 'STATE_CONFLICT',
  /** A configured capacity limit was hit (e.g. max active tokens). */
  RESOURCE_EXHAUSTED: 'RESOURCE_EXHAUSTED',
  /** Signing/verification or persistence computation failed. */
  COMPUTATION_FAILURE: 'COMPUTATION_FAILURE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly detail?: unknown;

  constructor(code: ErrorCode, message: string, httpStatus: number, detail?: unknown) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}

export const validationError = (message: string, detail?: unknown) =>
  new ServiceError(ErrorCode.VALIDATION_ERROR, message, 400, detail);

export const stateConflict = (message: string, detail?: unknown) =>
  new ServiceError(ErrorCode.STATE_CONFLICT, message, 409, detail);

export const resourceExhausted = (message: string, detail?: unknown) =>
  new ServiceError(ErrorCode.RESOURCE_EXHAUSTED, message, 503, detail);

export const computationFailure = (message: string, detail?: unknown) =>
  new ServiceError(ErrorCode.COMPUTATION_FAILURE, message, 500, detail);

export const tokenFailure = (
  code:
    | typeof ErrorCode.TOKEN_MALFORMED
    | typeof ErrorCode.TOKEN_INVALID_SIGNATURE
    | typeof ErrorCode.TOKEN_EXPIRED
    | typeof ErrorCode.TOKEN_REVOKED
    | typeof ErrorCode.TOKEN_ROTATED,
  message: string,
  detail?: unknown,
) => new ServiceError(code, message, 401, detail);
