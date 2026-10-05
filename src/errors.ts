import type { ErrorCategory } from './contracts.ts';

export class ServiceError extends Error {
  readonly category: ErrorCategory;
  readonly statusCode: number;

  constructor(category: ErrorCategory, message: string, statusCode: number) {
    super(message);
    this.name = 'ServiceError';
    this.category = category;
    this.statusCode = statusCode;
  }
}

export const inputError = (message: string, statusCode = 400): ServiceError =>
  new ServiceError('INPUT_ERROR', message, statusCode);

export const stateConflict = (message: string): ServiceError =>
  new ServiceError('STATE_CONFLICT', message, 409);

export const resourceExhausted = (message: string): ServiceError =>
  new ServiceError('RESOURCE_EXHAUSTED', message, 503);

export const executionFailed = (message: string): ServiceError =>
  new ServiceError('EXECUTION_FAILED', message, 500);

export const toApiError = (
  err: unknown,
): { statusCode: number; body: { error: { category: ErrorCategory; message: string } } } => {
  if (err instanceof ServiceError) {
    return { statusCode: err.statusCode, body: { error: { category: err.category, message: err.message } } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { statusCode: 500, body: { error: { category: 'EXECUTION_FAILED', message } } };
};
