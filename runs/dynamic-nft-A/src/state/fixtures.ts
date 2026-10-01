import type { DatabaseSync } from "node:sqlite";
import type { CollectionTemplate } from "../kernel/render.js";

export interface SeededCollection {
  collectionId: string;
  baseName: string;
  description: string;
  thresholds: number[];
  templates: CollectionTemplate;
  tokens: Array<{ tokenId: string }>;
  admins: string[];
}

export function seededData(): SeededCollection[] {
  const makeLevels = (baseName: string, tiers: string[], imageRefs: string[], levelNames: string[]) =>
    tiers.map((tier, i) => ({
      name: levelNames[i],
      tier,
      image: imageRefs[i],
    }));

  const heroThresholds = [10, 20, 40, 80];
  const heroTemplates: CollectionTemplate = {
    collectionId: "heroes",
    baseName: "Dynamic Hero",
    description: "A hero whose form evolves with accumulated experience.",
    levels: makeLevels(
      "Dynamic Hero",
      ["Recruit", "Veteran", "Elite", "Champion", "Mythic"],
      ["art://heroes/lvl1.png", "art://heroes/lvl2.png", "art://heroes/lvl3.png", "art://heroes/lvl4.png", "art://heroes/lvl5.png"],
      ["Recruit Form", "Veteran Form", "Elite Form", "Champion Form", "Mythic Form"],
    ),
  };

  const spriteThresholds = [7, 11, 17];
  const spriteTemplates: CollectionTemplate = {
    collectionId: "sprites",
    baseName: "Threshold Sprite",
    description: "Non-divisible threshold ladder fixture.",
    levels: makeLevels(
      "Threshold Sprite",
      ["Seed", "Sprout", "Bloom", "Apex"],
      ["art://sprites/lvl1.png", "art://sprites/lvl2.png", "art://sprites/lvl3.png", "art://sprites/lvl4.png"],
      ["Seed Form", "Sprout Form", "Bloom Form", "Apex Form"],
    ),
  };

  return [
    {
      collectionId: "heroes",
      baseName: heroTemplates.baseName,
      description: heroTemplates.description,
      thresholds: heroThresholds,
      templates: heroTemplates,
      tokens: [{ tokenId: "TKN-001" }, { tokenId: "TKN-002" }],
      admins: ["admin-alice"],
    },
    {
      collectionId: "sprites",
      baseName: spriteTemplates.baseName,
      description: spriteTemplates.description,
      thresholds: spriteThresholds,
      templates: spriteTemplates,
      tokens: [{ tokenId: "SPK-007" }],
      admins: ["admin-bob"],
    },
  ];
}

export function seedDatabase(db: DatabaseSync): void {
  const existing = db.prepare("SELECT COUNT(*) AS c FROM collections").get() as { c: number };
  if (existing.c > 0) return;

  const insertCollection = db.prepare(`
    INSERT INTO collections (collection_id, base_name, description, max_level, thresholds_json, templates_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertToken = db.prepare(`
    INSERT INTO tokens (collection_id, token_id, level, xp, consumed_xp, version)
    VALUES (?, ?, 1, 0, 0, 0)
  `);
  const insertAdmin = db.prepare(`
    INSERT INTO admins (collection_id, admin_id) VALUES (?, ?)
  `);

  for (const c of seededData()) {
    insertCollection.run(
      c.collectionId,
      c.baseName,
      c.description,
      c.thresholds.length + 1,
      JSON.stringify(c.thresholds),
      JSON.stringify(c.templates),
    );
    for (const t of c.tokens) insertToken.run(c.collectionId, t.tokenId);
    for (const a of c.admins) insertAdmin.run(c.collectionId, a);
  }
}

