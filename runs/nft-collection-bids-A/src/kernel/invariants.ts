import { computeError } from "../contract/errors.js";

export interface BalanceDelta {
  readonly userId: string;
  readonly deltaAvailable: number;
  readonly deltaFrozen: number;
  readonly kind: string;
}

export interface LedgerTotal {
  readonly available: number;
  readonly frozen: number;
}

/**
 * Conservation rule for every ledger transition:
 *   sum(delta_available + delta_frozen) == 0
 * Money is only moved between the two balance buckets or between accounts;
 * no transaction may create or destroy funds.
 */
export function assertDeltasConserve(deltas: readonly BalanceDelta[], context: Record<string, unknown>): void {
  const available = deltas.reduce((sum, delta) => sum + delta.deltaAvailable, 0);
  const frozen = deltas.reduce((sum, delta) => sum + delta.deltaFrozen, 0);
  if (available + frozen !== 0) {
    throw computeError("invariant_violation", "balance movements do not conserve the ledger total", {
      ...context,
      sumDeltaAvailable: available,
      sumDeltaFrozen: frozen,
      combined: available + frozen,
    });
  }
}

export function assertTotalsUnchanged(
  before: LedgerTotal,
  after: LedgerTotal,
  context: Record<string, unknown>,
): void {
  if (before.available !== after.available || before.frozen !== after.frozen) {
    throw computeError("invariant_violation", "ledger totals changed across the committed transaction", {
      ...context,
      before,
      after,
    });
  }
}

export function assertSplitsEqualPrice(params: {
  readonly price: number;
  readonly sellerAmount: number;
  readonly royaltyAmount: number;
  readonly splitAmounts: readonly number[];
  readonly context?: Record<string, unknown>;
}): void {
  const splitTotal = params.splitAmounts.reduce((sum, amount) => sum + amount, 0);
  if (splitTotal !== params.royaltyAmount || params.sellerAmount + params.royaltyAmount !== params.price) {
    throw computeError("invariant_violation", "royalty splits do not sum to the trade price", {
      price: params.price,
      sellerAmount: params.sellerAmount,
      royaltyAmount: params.royaltyAmount,
      splitTotal,
      ...(params.context ?? {}),
    });
  }
}
