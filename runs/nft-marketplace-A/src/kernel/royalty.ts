/**
 * Pure royalty arithmetic.
 *
 * royalty = floor(price * bps / 10000), sellerProceeds = price - royalty.
 * BigInt is used for the multiplication so large safe-integer prices cannot
 * lose precision before the floor division; results are checked to remain safe
 * integers.
 */

import { BPS_MAX, BPS_MIN } from '../contract/primitives.js';
import { RoyaltySplit } from '../contract/types.js';
import { ErrorReason, MarketError } from '../errors.js';

export const BPS_DENOMINATOR = 10000n;

export function computeRoyaltySplit(price: number, bps: number): RoyaltySplit {
  if (!Number.isSafeInteger(price) || price <= 0) {
    throw new MarketError(
      'computation',
      ErrorReason.IntegerOverflow,
      'Royalty calculation requires a positive safe-integer price',
      { price },
    );
  }
  if (!Number.isSafeInteger(bps) || bps < BPS_MIN || bps > BPS_MAX) {
    throw new MarketError(
      'computation',
      ErrorReason.IntegerOverflow,
      'Royalty calculation requires bps in [0,10000]',
      { bps },
    );
  }

  const gross = BigInt(price);
  const basisPoints = BigInt(bps);
  const royaltyBig = (gross * basisPoints) / BPS_DENOMINATOR;
  const sellerBig = gross - royaltyBig;

  if (royaltyBig > BigInt(Number.MAX_SAFE_INTEGER) || sellerBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MarketError(
      'computation',
      ErrorReason.IntegerOverflow,
      'Royalty split exceeds safe integer range',
      { price, bps },
    );
  }

  const royaltyAmount = Number(royaltyBig);
  const sellerProceeds = Number(sellerBig);
  return {
    grossPrice: price,
    royaltyBps: bps,
    royaltyAmount,
    sellerProceeds,
  };
}