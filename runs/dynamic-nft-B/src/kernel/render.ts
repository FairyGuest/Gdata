/**
 * Deterministic metadata renderer: metadata = f(level, xp, template).
 * Pure function; no clock, no randomness, no request ids. Byte-identical
 * output for identical input (fixed key order, JSON.stringify).
 */

export interface LevelTemplate {
  tier: string;
  image: string;
}

export interface CollectionTemplate {
  collectionId: string;
  baseName: string;
  /** static, level-independent attributes. */
  staticAttributes: ReadonlyArray<{ trait_type: string; value: string }>;
  /** per-level templates, index 0 = level 1. */
  levels: readonly LevelTemplate[];
}

export function renderMetadata(
  template: CollectionTemplate,
  tokenId: number,
  level: number,
  xp: number,
): string {
  const lt = template.levels[level - 1];
  if (!lt) {
    throw new Error("no level template for level " + level);
  }
  const metadata = {
    name: template.baseName + " #" + tokenId + " [" + lt.tier + "]",
    tier: lt.tier,
    image: lt.image,
    level,
    xp,
    attributes: [
      ...template.staticAttributes.map((a) => ({ trait_type: a.trait_type, value: a.value })),
      { trait_type: "Level", value: String(level) },
      { trait_type: "XP", value: String(xp) },
    ],
  };
  return JSON.stringify(metadata);
}
