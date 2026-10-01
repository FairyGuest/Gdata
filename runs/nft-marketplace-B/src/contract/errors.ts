export type ErrorCategory = 'input' | 'state' | 'policy' | 'resource' | 'internal';

export const HTTP_STATUS: Readonly<Record<ErrorCategory, number>> = {
  input: 422,
  state: 409,
  policy: 409,
  resource: 503,
  internal: 500,
};

export type ErrorReason =
  | 'invalid_body'
  | 'missing_field'
  | 'invalid_price'
  | 'invalid_bps'
  | 'unknown_collection'
  | 'unknown_token'
  | 'unknown_order'
  | 'unknown_user'
  | 'duplicate_listing'
  | 'order_not_open'
  | 'not_order_creator'
  | 'seller_not_owner'
  | 'insufficient_balance'
  | 'soulbound_transfer'
  | 'storage_unavailable'
  | 'lock_timeout'
  | 'conservation_violation'
  | 'unexpected';

export class MarketError extends Error {
  readonly category: ErrorCategory;
  readonly reason: ErrorReason;
  readonly details: Record<string, unknown> | undefined;

  constructor(category: ErrorCategory, reason: ErrorReason, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'MarketError';
    this.category = category;
    this.reason = reason;
    this.details = details;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.category];
  }
}

export const inputError = (reason: ErrorReason, message: string, details?: Record<string, unknown>): MarketError =>
  new MarketError('input', reason, message, details);

export const stateError = (reason: ErrorReason, message: string, details?: Record<string, unknown>): MarketError =>
  new MarketError('state', reason, message, details);

export const policyError = (reason: ErrorReason, message: string, details?: Record<string, unknown>): MarketError =>
  new MarketError('policy', reason, message, details);

export const resourceError = (reason: ErrorReason, message: string, details?: Record<string, unknown>): MarketError =>
  new MarketError('resource', reason, message, details);

export const internalError = (reason: ErrorReason, message: string, details?: Record<string, unknown>): MarketError =>
  new MarketError('internal', reason, message, details);

interface SqliteLikeError {
  code?: unknown;
  errcode?: unknown;
  message?: unknown;
}

export function isSqliteError(err: unknown): boolean {
  const e = err as SqliteLikeError | null | undefined;
  if (typeof e?.code !== 'string') return false;
  if ((e.code as string).startsWith('ERR_SQLITE')) return true;
  // node:sqlite reports operations on a closed/unavailable database this way.
  return e.code === 'ERR_INVALID_STATE' && typeof e.message === 'string' && /database is not open/i.test(e.message as string);
}

export function isSqliteBusy(err: unknown): boolean {
  const e = err as SqliteLikeError | null | undefined;
  if (e?.errcode === 5 || e?.errcode === 6) return true; // SQLITE_BUSY / SQLITE_LOCKED
  return typeof e?.message === 'string' && /database is locked|database table is locked/i.test(e.message as string);
}
