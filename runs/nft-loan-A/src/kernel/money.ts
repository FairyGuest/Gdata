// Independent integer money math. All amounts are integer minor units.
// BigInt is used so non-divisible interest is floored exactly, never via float.
//
// Interest denominator note: the mandated worked example in the task requires
//   principal=1003, perTickBps=5, elapsed=7 -> floor(35.105) = 35, due 1038.
// 1003 * 5 * 7 = 35105; reproducing 35.105 before flooring fixes the per-tick
// rate denominator at 1000 (collateral/liquidation bps still use 10000 below,
// e.g. 8000 bps loan-to-value = 80%). The worked example is the acceptance
// authority, so interest uses INTEREST_RATE_DENOMINATOR = 1000.
export const INTEREST_RATE_DENOMINATOR = 1000n;
export const BPS_DENOMINATOR = 10000n;

export function floorInterest(principal: number, perTickBps: number, elapsedTicks: number): number {
  if (principal < 0 || perTickBps < 0 || elapsedTicks < 0) {
    throw new Error('floorInterest received negative input');
  }
  const numerator = BigInt(principal) * BigInt(perTickBps) * BigInt(elapsedTicks);
  return Number(numerator / INTEREST_RATE_DENOMINATOR);
}

export function dueAmount(principal: number, perTickBps: number, elapsedTicks: number): number {
  return principal + floorInterest(principal, perTickBps, elapsedTicks);
}

// Collateral check: amount <= valuation * ltvBps / 10000 (cross-multiplied, exact).
export function isCollateralSufficient(amount: number, valuation: number, ltvBps: number): boolean {
  return BigInt(amount) * BPS_DENOMINATOR <= BigInt(valuation) * BigInt(ltvBps);
}

// Liquidation check: valuation < due * lineBps / 10000 (strictly below, exact).
export function isBelowLiquidationLine(valuation: number, due: number, lineBps: number): boolean {
  return BigInt(valuation) * BPS_DENOMINATOR < BigInt(due) * BigInt(lineBps);
}

