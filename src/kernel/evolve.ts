/**
 * Evolution kernel: pure arithmetic for XP accumulation and level transitions.
 * No I/O, no clock, no randomness. The state layer supplies the threshold
 * ladder and current state, and persists the result in the same transaction.
 */

export interface EvolutionInput {
  level: number;
  xp: number;
  /** thresholds[i] = XP cost to go from level (i+1) to (i+2). */
  thresholds: readonly number[];
  amount: number;
}

export interface EvolutionResult {
  level: number;
  xp: number;
  /** total threshold XP consumed by level-ups in this feed. */
  consumed: number;
  /** number of level-ups applied. */
  transitions: number;
  /** true when the token was already at max level before this feed. */
  alreadyMax: boolean;
}

export function maxLevel(thresholds: readonly number[]): number {
  return thresholds.length + 1;
}

/**
 * Apply one feed of `amount` XP. Level-ups consume the per-level threshold;
 * the remainder carries over. Feeding stops consuming at max level; leftover
 * XP stays as balance so the ledger stays conserved.
 */
export function applyFeed(input: EvolutionInput): EvolutionResult {
  let { level, xp } = input;
  const max = maxLevel(input.thresholds);
  if (level >= max) {
    return { level, xp, consumed: 0, transitions: 0, alreadyMax: true };
  }
  xp += input.amount;
  let consumed = 0;
  let transitions = 0;
  while (level < max && xp >= input.thresholds[level - 1]) {
    xp -= input.thresholds[level - 1];
    consumed += input.thresholds[level - 1];
    level += 1;
    transitions += 1;
  }
  return { level, xp, consumed, transitions, alreadyMax: false };
}
