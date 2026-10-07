// Shared error contract across all layers.
// category distinguishes: input errors (validation), state conflicts,
// resource exhaustion (quota), missing entities, and computation failures.

export type ErrorCategory = 'validation' | 'conflict' | 'quota_exceeded' | 'not_found' | 'internal';

export class LifecycleError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(category: ErrorCategory, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'LifecycleError';
    this.category = category;
    this.code = code;
    this.details = details;
  }
}

export class ParamValidationError extends LifecycleError {
  constructor(message: string, details: Record<string, unknown>) {
    super('validation', 'PARAM_VALIDATION', message, details);
  }
}

export class BranchConflictError extends LifecycleError {
  constructor(branch: string, existingEnvId: string) {
    super('conflict', 'BRANCH_ENV_EXISTS',
      `branch '${branch}' already has an active environment with different parameters`,
      { branch, existingEnvId });
  }
}

export class QuotaExceededError extends LifecycleError {
  constructor(owner: string, quota: number, activeEnvIds: string[]) {
    super('quota_exceeded', 'QUOTA_EXCEEDED',
      `owner '${owner}' reached active environment quota ${quota}`,
      { owner, quota, activeEnvIds });
  }
}

export class NotFoundError extends LifecycleError {
  constructor(envId: string) {
    super('not_found', 'ENV_NOT_FOUND', `environment '${envId}' not found`, { envId });
  }
}

export class InvalidStateError extends LifecycleError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super('conflict', code, message, details);
  }
}
