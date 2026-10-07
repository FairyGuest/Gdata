export type ErrorCategory =
  | 'INPUT_ERROR'
  | 'NOT_FOUND'
  | 'STATE_CONFLICT'
  | 'RESOURCE_EXHAUSTED'
  | 'COMPUTE_FAILURE';

export type ValidationIssueCode =
  | 'SCHEMA'
  | 'UNKNOWN_DEPENDENCY'
  | 'CYCLE'
  | 'PORT_CONFLICT'
  | 'ENV_UNRESOLVED';

export interface ValidationIssue {
  code: ValidationIssueCode;
  message: string;
  details?: unknown;
}

export class DomainError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly details: unknown;

  constructor(category: ErrorCategory, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'DomainError';
    this.category = category;
    this.code = code;
    this.details = details;
  }
}

export function errorBody(err: DomainError) {
  return {
    error: {
      category: err.category,
      code: err.code,
      message: err.message,
      details: err.details ?? null,
    },
  };
}
