/**
 * Independent arithmetic oracle written in a deliberately simple, different
 * style from src/kernel/evolve.ts, so tests do not self-certify via the
 * implementation under test.
 */
export function evolverIndependent(
  startLevel: number,
  startXp: number,
  startConsumed: number,
  feeds: number[],
  thresholds: number[],
): { level: number; xp: number; consumedXp: number } {
  let L = startLevel;
  let X = startXp;
  let C = startConsumed;
  const maxL = thresholds.length + 1;
  for (const gain of feeds) {
    X += gain;
    for (;;) {
      if (L === maxL) break;
      const need = thresholds[L - 1];
      if (X < need) break;
      X = X - need;
      C = C + need;
      L = L + 1;
    }
  }
  return { level: L, xp: X, consumedXp: C };
}

