/**
 * Error contract shared by all layers.
 * status -> category:
 *   422 input_error        (malformed params, bad XP value, unknown ids, bad admin)
 *   409 state_conflict     (e.g. max_level_reached)
 *   503 resource_exhausted (feed amount beyond capacity, db busy)
 *   500 compute_failure    (unexpected internal failure)
 * Each error carries a machine-distinguishable `reason`.
 */
export type ErrorCategory = "input_error" | "state_conflict" | "resource_exhausted" | "compute_failure";

const STATUS_BY_CATEGORY: Record<ErrorCategory, number> = {
  input_error: 422,
  state_conflict: 409,
  resource_exhausted: 503,
  compute_failure: 500,
};

export class ApiError extends Error {
  readonly category: ErrorCategory;
  readonly reason: string;
  readonly status: number;

  constructor(category: ErrorCategory, reason: string, message?: string) {
    super(message ?? reason);
    this.category = category;
    this.reason = reason;
    this.status = STATUS_BY_CATEGORY[category];
  }

  toBody() {
    return { error: { category: this.category, reason: this.reason, status: this.status } };
  }
}

export const inputError = (reason: string, msg?: string) => new ApiError("input_error", reason, msg);
export const stateConflict = (reason: string, msg?: string) => new ApiError("state_conflict", reason, msg);
export const resourceExhausted = (reason: string, msg?: string) => new ApiError("resource_exhausted", reason, msg);
export const computeFailure = (reason: string, msg?: string) => new ApiError("compute_failure", reason, msg);
