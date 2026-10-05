// Error contract: every failure crossing a module boundary is an EngineError
// with a stable category. Callers must be able to distinguish failure kinds
// without parsing message text.

export const ERROR_CATEGORIES = [
  'INPUT_ERROR', // malformed request/rule/source (client's fault)
  'NOT_FOUND', // referenced entity does not exist
  'STATE_CONFLICT', // conflicts with persisted state (e.g. duplicate rule)
  'RESOURCE_EXHAUSTED', // configured limits exceeded
  'COMPUTATION_FAILURE', // unexpected internal failure
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const CATEGORY_HTTP_STATUS: Record<ErrorCategory, number> = {
  INPUT_ERROR: 400,
  NOT_FOUND: 404,
  STATE_CONFLICT: 409,
  RESOURCE_EXHAUSTED: 503,
  COMPUTATION_FAILURE: 500,
};

export class EngineError extends Error {
  readonly category: ErrorCategory;
  readonly detail?: unknown;
  constructor(category: ErrorCategory, message: string, detail?: unknown) {
    super(message);
    this.name = 'EngineError';
    this.category = category;
    this.detail = detail;
  }
  get httpStatus(): number {
    return CATEGORY_HTTP_STATUS[this.category];
  }
}

export function isEngineError(err: unknown): err is EngineError {
  return err instanceof EngineError;
}

// Normalize anything thrown at a boundary into an EngineError.
export function toEngineError(err: unknown): EngineError {
  if (isEngineError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new EngineError('COMPUTATION_FAILURE', message);
}
