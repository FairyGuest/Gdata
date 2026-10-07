export type ErrorCategory =
  | 'VALIDATION_ERROR'
  | 'UNKNOWN_PARAMETER'
  | 'LIMIT_EXCEEDED'
  | 'CONFLICT_ACTIVE_INSTANCE'
  | 'STATE_CONFLICT'
  | 'TERMINAL_STATE'
  | 'NOT_FOUND'
  | 'RESOURCE_EXHAUSTED'
  | 'INTERNAL';

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly httpStatus: number;
  readonly detail?: string;
  constructor(category: ErrorCategory, httpStatus: number, message: string, detail?: string) {
    super(message);
    this.category = category;
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}

export const validationError = (msg: string, detail?: string) =>
  new AppError('VALIDATION_ERROR', 400, msg, detail);
export const unknownParameter = (param: string) =>
  new AppError('UNKNOWN_PARAMETER', 400, 'Unknown override parameter: ' + param, param);
export const limitExceeded = (what: string, detail?: string) =>
  new AppError('LIMIT_EXCEEDED', 400, 'Limit exceeded: ' + what, detail);
export const conflictActiveInstance = (name: string) =>
  new AppError('CONFLICT_ACTIVE_INSTANCE', 409, "An active environment named '" + name + "' already exists", name);
export const stateConflict = (msg: string, detail?: string) =>
  new AppError('STATE_CONFLICT', 409, msg, detail);
export const terminalState = (name: string) =>
  new AppError('TERMINAL_STATE', 410, "Environment '" + name + "' is deleted (terminal state); no further operations are allowed", name);
export const notFound = (what: string) =>
  new AppError('NOT_FOUND', 404, 'Not found: ' + what, what);
export const resourceExhausted = (msg: string) =>
  new AppError('RESOURCE_EXHAUSTED', 503, msg);
