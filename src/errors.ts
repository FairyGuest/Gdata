export type ErrorCode =
  | "invalid_input"
  | "invalid_token"
  | "expired"
  | "revoked"
  | "rotated"
  | "refresh_conflict"
  | "internal";

export const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_input: 400,
  invalid_token: 401,
  expired: 401,
  revoked: 401,
  rotated: 401,
  refresh_conflict: 409,
  internal: 500,
};

export interface TokenError {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    reason?: string;
  };
}

export type Result<T> = { ok: true; value: T } | TokenError;

export function fail(code: ErrorCode, message: string, reason?: string): TokenError {
  return { ok: false, error: { code, message, ...(reason ? { reason } : {}) } };
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}