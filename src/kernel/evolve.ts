import { Ladder, maxLevel, thresholdForLevel } from "./ladder.js";
import { computeFailure } from "../contract/errors.js";

export interface TokenState {
  level: number;
  xp: number;
  consumedXp: number;
}

export interface EvolveResult extends TokenState {
  levelsGained: number;
  levelsTrail: number[];
}

export function evolve(state: TokenState, amount: number, ladder: Ladder): EvolveResult {
  if (!Number.isSafeInteger(state.xp) || state.xp < 0) {
    throw computeFailure("invalid_token_xp", { xp: state.xp });
  }
  if (!Number.isSafeInteger(state.consumedXp) || state.consumedXp < 0) {
    throw computeFailure("invalid_consumed_xp", { consumedXp: state.consumedXp });
  }
  if (!Number.isSafeInteger(state.level) || state.level < 1) {
    throw computeFailure("invalid_token_level", { level: state.level });
  }

  let level = state.level;
  let xp = state.xp + amount;
  let consumedXp = state.consumedXp;
  let levelsGained = 0;
  const levelsTrail: number[] = [level];

  const cap = maxLevel(ladder);
  while (level < cap) {
    const threshold = thresholdForLevel(ladder, level);
    if (threshold === null) {
      throw computeFailure("ladder_threshold_unavailable", { level });
    }
    if (xp < threshold) break;
    xp -= threshold;
    consumedXp += threshold;
    level += 1;
    levelsGained += 1;
    levelsTrail.push(level);
  }

  if (!Number.isSafeInteger(xp) || !Number.isSafeInteger(consumedXp)) {
    throw computeFailure("xp_overflow", { xp, consumedXp });
  }

  return { level, xp, consumedXp, levelsGained, levelsTrail };
}
