export type ErrorCategory = 'INPUT' | 'STATE' | 'RESOURCE' | 'COMPUTE';

export type VaultErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'VERSION_EXPIRED'
  | 'CONFLICT'
  | 'RESOURCE_EXHAUSTED'
  | 'CRYPTO_FAILURE'
  | 'AUDIT_INTEGRITY_FAILURE'
  | 'INTERNAL';

const CATEGORY_BY_CODE: Record<VaultErrorCode, ErrorCategory> = {
  VALIDATION: 'INPUT',
  NOT_FOUND: 'STATE',
  VERSION_EXPIRED: 'STATE',
  CONFLICT: 'STATE',
  RESOURCE_EXHAUSTED: 'RESOURCE',
  CRYPTO_FAILURE: 'COMPUTE',
  AUDIT_INTEGRITY_FAILURE: 'COMPUTE',
  INTERNAL: 'COMPUTE',
};

const STATUS_BY_CODE: Record<VaultErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  VERSION_EXPIRED: 410,
  CONFLICT: 409,
  RESOURCE_EXHAUSTED: 413,
  CRYPTO_FAILURE: 500,
  AUDIT_INTEGRITY_FAILURE: 500,
  INTERNAL: 500,
};

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  readonly category: ErrorCategory;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(code: VaultErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
    this.category = CATEGORY_BY_CODE[code];
    this.httpStatus = STATUS_BY_CODE[code];
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        category: this.category,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export function toVaultError(err: unknown): VaultError {
  if (err instanceof VaultError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new VaultError('INTERNAL', message);
}
