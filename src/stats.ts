// Pure statistics. Percentile method: nearest-rank on the sorted sample.
import type { LatencyStats } from './contracts.ts';

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

export function summarize(latencies: number[]): LatencyStats {
  const sorted = [...latencies].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count,
    min: count ? sorted[0] : 0,
    max: count ? sorted[count - 1] : 0,
    mean: count ? sum / count : 0,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}
