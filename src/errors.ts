export type ErrorCategory =
  | "input_error"
  | "state_conflict"
  | "resource_exhausted"
  | "computation_failure";

export interface OAuthErrorSpec {
  error: string;
  errorDescription: string;
  category: ErrorCategory;
  httpStatus: number;
}

export class OAuthError extends Error {
  readonly spec: OAuthErrorSpec;

  constructor(spec: OAuthErrorSpec) {
    super(spec.errorDescription);
    this.name = "OAuthError";
    this.spec = spec;
  }

  toJSON() {
    return {
      error: this.spec.error,
      error_description: this.spec.errorDescription,
      error_category: this.spec.category,
    };
  }
}

export const Errors = {
  invalidRequest: (desc: string) =>
    new OAuthError({ error: "invalid_request", errorDescription: desc, category: "input_error", httpStatus: 400 }),
  invalidClient: (desc: string) =>
    new OAuthError({ error: "invalid_client", errorDescription: desc, category: "input_error", httpStatus: 401 }),
  unsupportedGrantType: (desc: string) =>
    new OAuthError({ error: "unsupported_grant_type", errorDescription: desc, category: "input_error", httpStatus: 400 }),
  invalidGrant: (desc: string) =>
    new OAuthError({ error: "invalid_grant", errorDescription: desc, category: "state_conflict", httpStatus: 400 }),
  resourceExhausted: (desc: string) =>
    new OAuthError({ error: "temporarily_unavailable", errorDescription: desc, category: "resource_exhausted", httpStatus: 503 }),
  computationFailure: (desc: string) =>
    new OAuthError({ error: "server_error", errorDescription: desc, category: "computation_failure", httpStatus: 500 }),
};

export function toOAuthError(err: unknown): OAuthError {
  if (err instanceof OAuthError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return Errors.computationFailure("unexpected internal failure: " + msg);
}
