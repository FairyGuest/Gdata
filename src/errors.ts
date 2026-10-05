export type ErrorCategory =
  | 'INPUT_ERROR'
  | 'STATE_CONFLICT'
  | 'RESOURCE_EXHAUSTED'
  | 'COMPUTATION_FAILED'
  | 'NOT_FOUND'
  | 'INTERNAL';

const STATUS_BY_CATEGORY: Record<ErrorCategory, number> = {
  INPUT_ERROR: 400,
  STATE_CONFLICT: 409,
  RESOURCE_EXHAUSTED: 429,
  COMPUTATION_FAILED: 502,
  NOT_FOUND: 404,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly status: number;
  readonly detail?: unknown;

  constructor(category: ErrorCategory, message: string, detail?: unknown) {
    super(message);
    this.name = 'AppError';
    this.category = category;
    this.status = STATUS_BY_CATEGORY[category];
    this.detail = detail;
  }
}

export function toErrorBody(err: unknown): {
  status: number;
  body: { error: { code: ErrorCategory; message: string; detail?: unknown } };
} {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: {
        error: {
          code: err.category,
          message: err.message,
          ...(err.detail !== undefined ? { detail: err.detail } : {}),
        },
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: { code: 'INTERNAL', message } } };
}
