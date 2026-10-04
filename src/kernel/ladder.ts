export interface Ladder {
  readonly thresholds: number[];
}

export function maxLevel(ladder: Ladder): number {
  return ladder.thresholds.length + 1;
}

export function thresholdForLevel(ladder: Ladder, level: number): number | null {
  if (level < 1 || level > ladder.thresholds.length) return null;
  const t = ladder.thresholds[level - 1];
  if (!Number.isInteger(t) || t <= 0) {
    throw new Error("invalid_ladder_threshold");
  }
  return t;
}
