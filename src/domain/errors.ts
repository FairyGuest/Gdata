/** 统一错误契约：所有可预期失败都有稳定的 code，HTTP 层据此映射状态码。 */
export const ErrorCodes = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  KEY_UNKNOWN: 'KEY_UNKNOWN',
  KEY_EXPIRED: 'KEY_EXPIRED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  KEY_UNKNOWN: 401,
  KEY_EXPIRED: 403,
  QUOTA_EXCEEDED: 409,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function toErrorBody(err: unknown): { code: ErrorCode; message: string; details: Record<string, unknown> } {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, details: err.details };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'INTERNAL', message, details: {} };
}

