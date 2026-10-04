/** System-wide constant configuration (fixture-grade, no env needed). */
export const CONFIG = {
  /** Collateral ratio in bps: amount*10000 <= valuation*COLLATERAL_RATIO_BPS */
  COLLATERAL_RATIO_BPS: 5000,
  /** Liquidation line in bps: liquidatable when valuation*10000 < debt*LIQUIDATION_LINE_BPS */
  LIQUIDATION_LINE_BPS: 11000,
  /**
   * Per-tick interest denominator. interest = floor(principal * perTickBps * elapsedTicks / DENOM).
   * With DENOM=1000 a perTickBps of 5 means 0.5% per tick, so the reference vector
   * principal=1003, perTickBps=5, elapsed=7 yields floor(35.105) = 35.
   */
  INTEREST_DENOMINATOR: 1000n,
  /** Lender / funding pool account id. */
  POOL_ID: "lender",
  /** Escrow owner marker while a token is pledged. */
  ESCROW_ID: "escrow",
} as const;
