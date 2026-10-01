/**
 * Cross-layer error contract.
 *
 * Every failure that crosses a module boundary is a MarketError carrying:
 *  - category: coarse bucket that drives the HTTP status mapping
 *  - reason:   stable, machine-readable, distinguishable code
 *  - details:  replayable context (runId, orderId, tokenId, ...)
 *  - audit:    optional state-transition / decision information for diag
 *
 * Unknown/unexpected failures are never silently turned into success: they
 * map to 500 computation.unexpected.
 */

export type ErrorCategory =
  | 'input'
  | 'state'
  | 'policy'
  | 'resource'
  | 'computation';

export const ErrorReason = {
  // 422 input errors
  MissingField: 'input.missing_field',
  BadType: 'input.bad_type',
  PriceNotPositiveInteger: 'input.price_not_positive_integer',
  BpsOutOfRange: 'input.bps_out_of_range',
  UnknownCollection: 'input.unknown_collection',
  UnknownToken: 'input.unknown_token',
  UnknownOrder: 'input.unknown_order',
  UnknownUser: 'input.unknown_user',

  // 409 state conflicts
  DuplicateListing: 'conflict.duplicate_listing',
  OrderAlreadyFilled: 'conflict.order_already_filled',
  OrderAlreadyCancelled: 'conflict.order_already_cancelled',
  NotOrderCreator: 'conflict.not_order_creator',
  SellerNotHolder: 'conflict.seller_not_holder',
  InsufficientBalance: 'conflict.insufficient_balance',

  // 409 policy conflicts (independent category/reason from ordinary state conflicts)
  SoulboundListing: 'policy.soulbound_listing',
  SoulboundAccept: 'policy.soulbound_accept',

  // 503 resource exhaustion
  StorageUnavailable: 'resource.storage_unavailable',
  LockTimeout: 'resource.lock_timeout',

  // 500 computation failures
  ConservationViolation: 'computation.conservation_violation',
  IntegerOverflow: 'computation.integer_overflow',
  Unexpected: 'computation.unexpected',
} as const;

export type ErrorReason = (typeof ErrorReason)[keyof typeof ErrorReason];

export const HTTP_STATUS_BY_CATEGORY: Record<ErrorCategory, number> = {
  input: 422,
  state: 409,
  policy: 409,
  resource: 503,
  computation: 500,
};

export interface ErrorAudit {
  action?: string;
  orderId?: string;
  tokenId?: string;
  transition?: { from: string; to: string } | null;
  basis?: string;
  commitSeq?: number | null;
}

export class MarketError extends Error {
  readonly category: ErrorCategory;
  readonly reason: ErrorReason;
  readonly details: Record<string, unknown>;
  readonly audit: ErrorAudit;

  constructor(
    category: ErrorCategory,
    reason: ErrorReason,
    message: string,
    details: Record<string, unknown> = {},
    audit: ErrorAudit = {},
  ) {
    super(message);
    this.name = 'MarketError';
    this.category = category;
    this.reason = reason;
    this.details = details;
    this.audit = audit;
  }

  get httpStatus(): number {
    return HTTP_STATUS_BY_CATEGORY[this.category];
  }

  toBody(): {
    error: {
      category: ErrorCategory;
      reason: ErrorReason;
      message: string;
      details: Record<string, unknown>;
    };
  } {
    return {
      error: {
        category: this.category,
        reason: this.reason,
        message: this.message,
        details: this.details,
      },
    };
  }
}

export function isMarketError(value: unknown): value is MarketError {
  return value instanceof MarketError;
}
