
export type ErrorCategory = "input" | "state" | "resource" | "internal";

export class OAuthError extends Error {
  readonly category: ErrorCategory;
  readonly oauthError: string;
  readonly httpStatus: number;
  constructor(category: ErrorCategory, oauthError: string, httpStatus: number, message: string) {
    super(message);
    this.name = "OAuthError";
    this.category = category;
    this.oauthError = oauthError;
    this.httpStatus = httpStatus;
  }
  toJSON() {
    return {
      error: this.oauthError,
      error_category: this.category,
      error_description: this.message,
    };
  }
}

export const inputError = (msg: string) =>
  new OAuthError("input", "invalid_request", 400, msg);
export const stateError = (msg: string, oauthError = "invalid_grant") =>
  new OAuthError("state", oauthError, 400, msg);
export const resourceError = (msg: string) =>
  new OAuthError("resource", "temporarily_unavailable", 503, msg);
export const internalError = (msg: string) =>
  new OAuthError("internal", "server_error", 500, msg);

export function toOAuthError(e: unknown): OAuthError {
  if (e instanceof OAuthError) return e;
  return internalError(e instanceof Error ? e.message : String(e));
}
