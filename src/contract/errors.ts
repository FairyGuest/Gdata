export type ErrorCategory =
  | 'INPUT_ERROR'
  | 'STATE_CONFLICT'
  | 'RESOURCE_EXHAUSTED'
  | 'COMPUTE_FAILURE';

export class FactoryError extends Error {
  readonly category: ErrorCategory;
  readonly details: unknown;

  constructor(category: ErrorCategory, message: string, details?: unknown) {
    super(message);
    this.name = 'FactoryError';
    this.category = category;
    this.details = details;
  }
}

export function httpStatusFor(category: ErrorCategory, message = ''): number {
  switch (category) {
    case 'INPUT_ERROR':
      return 400;
    case 'STATE_CONFLICT':
      return /not found/i.test(message) ? 404 : 409;
    case 'RESOURCE_EXHAUSTED':
      return 413;
    case 'COMPUTE_FAILURE':
      return 500;
  }
}

export function toErrorBody(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof FactoryError) {
    return {
      status: httpStatusFor(err.category, err.message),
      body: { error: { category: err.category, message: err.message, details: err.details ?? null } },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    body: { error: { category: 'COMPUTE_FAILURE', message: 'unexpected: ' + message, details: null } },
  };
}