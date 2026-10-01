/**
 * Primitive domain validation. These rules belong to the contract layer and
 * are reused by request parsing and synthetic-fixture/admin ingestion.
 */

import { ErrorReason, MarketError } from '../errors.js';

export const BPS_MIN = 0;
export const BPS_MAX = 10000;

export function requireNonEmptyString(
  value: unknown,
  field: string,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MarketError(
      'input',
      ErrorReason.MissingField,
      `Field '${field}' is required and must be a non-empty string`,
      { field, received: describeReceived(value) },
    );
  }
  return value;
}

/**
 * Price must be a strictly positive safe integer expressed in the ledger's
 * indivisible unit. Strings are not coerced: a shaped-wrong request is a
 * distinct input failure.
 */
export function parsePositiveInteger(value: unknown, field = 'price'): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value > 0) return value;
  } else if (typeof value === 'bigint') {
    if (value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
  }
  throw new MarketError(
    'input',
    ErrorReason.PriceNotPositiveInteger,
    `Field '${field}' must be a positive safe integer`,
    { field, received: describeReceived(value) },
  );
}

export function validateBps(bps: unknown, field = 'royaltyBps'): number {
  if (typeof bps !== 'number' || !Number.isSafeInteger(bps)) {
    throw new MarketError(
      'input',
      ErrorReason.BpsOutOfRange,
      `Field '${field}' must be an integer in [${BPS_MIN}, ${BPS_MAX}]`,
      { field, received: describeReceived(bps), min: BPS_MIN, max: BPS_MAX },
    );
  }
  if (bps < BPS_MIN || bps > BPS_MAX) {
    throw new MarketError(
      'input',
      ErrorReason.BpsOutOfRange,
      `Field '${field}' must be in [${BPS_MIN}, ${BPS_MAX}] bps`,
      { field, received: bps, min: BPS_MIN, max: BPS_MAX },
    );
  }
  return bps;
}

export function describeReceived(value: unknown): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'number' || t === 'string' || t === 'boolean') return value;
  return `[${t}]`;
}

/** Fixture ingestion helper: non-negative safe integer balances only. */
export function assertNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MarketError(
      'input',
      ErrorReason.BadType,
      `Field '${field}' must be a non-negative safe integer`,
      { field, received: value },
    );
  }
  return value;
}
