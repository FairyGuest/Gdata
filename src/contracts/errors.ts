export type ErrorCategory =
  | 'INPUT_ERROR'
  | 'STATE_CONFLICT'
  | 'NOT_FOUND'
  | 'RESOURCE_EXHAUSTED'
  | 'COMPUTATION_ERROR';

export class EngineError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;

  constructor(category: ErrorCategory, code: string, message: string) {
    super(message);
    this.name = 'EngineError';
    this.category = category;
    this.code = code;
  }
}

export function isEngineError(err: unknown): err is EngineError {
  return err instanceof EngineError;
}

export const httpStatusFor = (category: ErrorCategory): number => {
  switch (category) {
    case 'INPUT_ERROR':
      return 400;
    case 'STATE_CONFLICT':
      return 409;
    case 'NOT_FOUND':
      return 404;
    case 'RESOURCE_EXHAUSTED':
      return 413;
    case 'COMPUTATION_ERROR':
      return 500;
  }
};

