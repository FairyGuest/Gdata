export type ErrorCode =
  | 'CONTRACT_PARSE_ERROR'
  | 'VALIDATION_CYCLE'
  | 'VALIDATION_PORT_CONFLICT'
  | 'VALIDATION_MISSING_ENV'
  | 'VALIDATION_UNKNOWN_DEPENDENCY'
  | 'NOT_FOUND'
  | 'STATE_CONFLICT'
  | 'RESOURCE_EXHAUSTED'
  | 'COMPUTATION_FAILED';

const HTTP_STATUS: Record<ErrorCode, number> = {
  CONTRACT_PARSE_ERROR: 400,
  VALIDATION_CYCLE: 422,
  VALIDATION_PORT_CONFLICT: 422,
  VALIDATION_MISSING_ENV: 422,
  VALIDATION_UNKNOWN_DEPENDENCY: 422,
  NOT_FOUND: 404,
  STATE_CONFLICT: 409,
  RESOURCE_EXHAUSTED: 507,
  COMPUTATION_FAILED: 500,
};

export class OrchestrationError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'OrchestrationError';
    this.code = code;
    this.details = details;
    this.httpStatus = HTTP_STATUS[code];
  }
}

export function errorBody(err: OrchestrationError, runId?: string) {
  return {
    error: {
      code: err.code,
      message: err.message,
      details: err.details ?? null,
      ...(runId ? { runId } : {}),
    },
  };
}
