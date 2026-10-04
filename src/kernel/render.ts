export interface LevelTemplate {
  name: string;
  tier: string;
  image: string;
}

export interface CollectionTemplate {
  collectionId: string;
  baseName: string;
  description: string;
  levels: LevelTemplate[];
}

export interface TokenView {
  tokenId: string;
  collectionId: string;
  level: number;
  xp: number;
}

export interface NftMetadata {
  name: string;
  description: string;
  image: string;
  tokenId: string;
  collectionId: string;
  attributes: Array<{ trait_type: string; value: string | number }>;
}

export function renderMetadata(view: TokenView, template: CollectionTemplate): NftMetadata {
  const tpl = template.levels[view.level - 1];
  if (!tpl) {
    throw new Error("template_level_missing");
  }
  const name = template.baseName + " #" + view.tokenId + " · " + tpl.name;
  return {
    name,
    description: template.description,
    image: tpl.image,
    tokenId: view.tokenId,
    collectionId: view.collectionId,
    attributes: [
      { trait_type: "Level", value: view.level },
      { trait_type: "XP", value: view.xp },
      { trait_type: "Tier", value: tpl.tier },
    ],
  };
}

export function renderMetadataBytes(view: TokenView, template: CollectionTemplate): Buffer {
  return Buffer.from(JSON.stringify(renderMetadata(view, template)), "utf8");
}

