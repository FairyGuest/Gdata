import { computeError } from "./errors.js";
import type { RoyaltyRecipient } from "./models.js";

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Royalty is defined as floor(bid * bps / 10000).
 * The buyer always pays exactly `bid`; the seller receives bid - royalty.
 */
export function computeRoyaltyAmount(bidAmount: number, royaltyBps: number): number {
  if (!isPositiveSafeInteger(bidAmount) || !isNonNegativeSafeInteger(royaltyBps) || royaltyBps > 10000) {
    throw computeError("invariant_violation", "royalty inputs out of contract range", { bidAmount, royaltyBps });
  }
  return Math.floor((bidAmount * royaltyBps) / 10000);
}

export interface PaymentSplit {
  readonly sellerAmount: number;
  readonly royaltyAmount: number;
  readonly recipientPayments: ReadonlyArray<{ readonly userId: string; readonly amount: number }>;
}

/**
 * Allocates the royalty total across recipients proportionally using the
 * largest-remainder method so the individual payments sum back to the royalty
 * total exactly (sum of split parts must equal the trade price).
 */
export function allocateRoyalty(
  royaltyAmount: number,
  recipients: readonly RoyaltyRecipient[],
): ReadonlyArray<{ readonly userId: string; readonly amount: number }> {
  if (royaltyAmount === 0) return recipients.map((recipient) => ({ userId: recipient.userId, amount: 0 }));
  const totalWeight = recipients.reduce((sum, recipient) => sum + recipient.weight, 0);
  if (!Number.isSafeInteger(totalWeight) || totalWeight <= 0) {
    throw computeError("invariant_violation", "royalty recipient weights must sum to a positive integer", {
      totalWeight,
    });
  }
  const exact = recipients.map((recipient) => ({
    userId: recipient.userId,
    exact: (royaltyAmount * recipient.weight) / totalWeight,
  }));
  const floors = exact.map((entry) => ({ userId: entry.userId, amount: Math.floor(entry.exact) }));
  let remainder = royaltyAmount - floors.reduce((sum, entry) => sum + entry.amount, 0);
  const order = exact
    .map((entry, index) => ({ index, fraction: entry.exact - Math.floor(entry.exact), userId: entry.userId }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (const entry of order) {
    if (remainder <= 0) break;
    const target = floors[entry.index];
    if (target) {
      target.amount += 1;
      remainder -= 1;
    }
  }
  if (remainder !== 0) {
    throw computeError("invariant_violation", "royalty allocation remainder could not be distributed", { remainder });
  }
  return floors;
}

export function splitPayment(
  bidAmount: number,
  royaltyBps: number,
  recipients: readonly RoyaltyRecipient[],
): PaymentSplit {
  const royaltyAmount = computeRoyaltyAmount(bidAmount, royaltyBps);
  const recipientPayments = allocateRoyalty(royaltyAmount, recipients);
  const sellerAmount = bidAmount - royaltyAmount;
  const recipientTotal = recipientPayments.reduce((sum, payment) => sum + payment.amount, 0);
  if (recipientTotal !== royaltyAmount || sellerAmount + royaltyAmount !== bidAmount) {
    throw computeError("invariant_violation", "payment split does not conserve the trade price", {
      bidAmount,
      royaltyAmount,
      recipientTotal,
      sellerAmount,
    });
  }
  return { sellerAmount, royaltyAmount, recipientPayments };
}
