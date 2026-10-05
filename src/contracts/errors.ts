export type ErrorCategory =
  | 'input_error'
  | 'state_conflict'
  | 'resource_exhausted'
  | 'computation_failure';

export class ChaosError extends Error {
  constructor(
    public readonly category: ErrorCategory,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InputError extends ChaosError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('input_error', message, details);
  }
}

export class StateConflictError extends ChaosError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('state_conflict', message, details);
  }
}

export class ResourceExhaustedError extends ChaosError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('resource_exhausted', message, details);
  }
}

export class ComputationError extends ChaosError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('computation_failure', message, details);
  }
}

export const CATEGORY_HTTP_STATUS: Record<ErrorCategory, number> = {
  input_error: 400,
  state_conflict: 409,
  resource_exhausted: 503,
  computation_failure: 502,
};

export function toErrorBody(err: unknown): { status: number; body: unknown } {
  if (err instanceof ChaosError) {
    return {
      status: CATEGORY_HTTP_STATUS[err.category],
      body: { error: { category: err.category, message: err.message, details: err.details ?? null } },
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    body: { error: { category: 'computation_failure', message: 'unexpected internal error: ' + msg, details: null } },
  };
}