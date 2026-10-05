export type ErrorCode =
  | 'INVALID_PAYLOAD'
  | 'MISSING_FIELD'
  | 'UNKNOWN_STATUS'
  | 'INVALID_QUERY'
  | 'STATUS_CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'REPORT_NOT_FOUND'
  | 'AGGREGATION_FAILED'
  | 'DB_FAILURE'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, httpStatus: number, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/** 400 - the request body or query does not satisfy the input contract. */
export class ContractError extends AppError {
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(code, 400, message, details);
  }
}

/** 409 - two runs in the same ingestion disagree about a test's status. */
export class StateConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super('STATUS_CONFLICT', 409, message, details);
  }
}

/** 413 - configured size limits exceeded. */
export class ResourceExhaustedError extends AppError {
  constructor(message: string, details?: unknown) {
    super('PAYLOAD_TOO_LARGE', 413, message, details);
  }
}

/** 404 - referenced report does not exist. */
export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown) {
    super('REPORT_NOT_FOUND', 404, message, details);
  }
}

/** 500 - aggregation or persistence failed internally. */
export class ComputationError extends AppError {
  constructor(code: 'AGGREGATION_FAILED' | 'DB_FAILURE', message: string, details?: unknown) {
    super(code, 500, message, details);
  }
}
