// Latency distribution statistics. Percentile method: linear interpolation
// between closest ranks (same as numpy default "linear"), on a sorted copy.
// Pure functions; throws AppError(CALCULATION_FAILED) on invalid input.

import { AppError } from "./errors.ts";
import type { StatsBlock } from "./types.ts";

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) {
    throw new AppError("CALCULATION_FAILED", "percentile of empty sample");
  }
  if (p < 0 || p > 100) {
    throw new AppError("CALCULATION_FAILED", `percentile must be in [0,100], got ${p}`);
  }
  const n = sortedAsc.length;
  if (n === 1) return sortedAsc[0];
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

export function computeStats(latenciesMs: number[]): StatsBlock {
  if (!Array.isArray(latenciesMs) || latenciesMs.length === 0) {
    throw new AppError("CALCULATION_FAILED", "cannot compute stats of empty sample");
  }
  for (const v of latenciesMs) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new AppError("CALCULATION_FAILED", "sample contains invalid latency", { value: v });
    }
  }
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    avgMs: sum / sorted.length,
    p50Ms: percentile(sorted, 50),
    p90Ms: percentile(sorted, 90),
    p99Ms: percentile(sorted, 99),
  };
}
