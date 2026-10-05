export type ErrorCode =
  | 'INPUT_ERROR'
  | 'STATE_CONFLICT'
  | 'RESOURCE_EXHAUSTED'
  | 'COMPUTATION_FAILED'
  | 'NOT_FOUND';

const HTTP_STATUS: Record<ErrorCode, number> = {
  INPUT_ERROR: 400,
  STATE_CONFLICT: 409,
  RESOURCE_EXHAUSTED: 503,
  COMPUTATION_FAILED: 500,
  NOT_FOUND: 404,
};

export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.details = details;
  }
}

export function toErrorBody(err: unknown): { status: number; body: { error: { code: ErrorCode | 'INTERNAL_ERROR'; message: string; details?: unknown } } } {
  if (err instanceof ServiceError) {
    return { status: err.httpStatus, body: { error: { code: err.code, message: err.message, details: err.details } } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message } } };
}
