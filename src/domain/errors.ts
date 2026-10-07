/** Error taxonomy. Each category maps to a distinct HTTP status and code. */

export type ErrorCode =
  | 'INPUT_ERROR'
  | 'STATE_CONFLICT'
  | 'RESOURCE_EXHAUSTED'
  | 'COMPUTATION_ERROR'
  | 'NOT_FOUND';

export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, httpStatus: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export const inputError = (message: string, details?: unknown): ServiceError =>
  new ServiceError('INPUT_ERROR', 400, message, details);

export const notFound = (message: string, details?: unknown): ServiceError =>
  new ServiceError('NOT_FOUND', 404, message, details);

export const stateConflict = (message: string, details?: unknown): ServiceError =>
  new ServiceError('STATE_CONFLICT', 409, message, details);

export const resourceExhausted = (message: string, details?: unknown): ServiceError =>
  new ServiceError('RESOURCE_EXHAUSTED', 507, message, details);

export const computationError = (message: string, details?: unknown): ServiceError =>
  new ServiceError('COMPUTATION_ERROR', 500, message, details);