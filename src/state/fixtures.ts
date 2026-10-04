import type { CollectionRow, RoyaltyRecipient } from "../contract/models.js";

export interface FixtureUser {
  readonly userId: string;
  readonly availableBalance: number;
  readonly frozenBalance: number;
  readonly label: string;
}

export interface FixtureToken {
  readonly tokenId: string;
  readonly collectionId: string;
  readonly ownerId: string;
}

export interface FixtureData {
  readonly users: readonly FixtureUser[];
  readonly collections: readonly CollectionRow[];
  readonly tokens: readonly FixtureToken[];
  readonly seed: number;
}

/** Deterministic PRNG: same seed always yields the same auxiliary ledger rows. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds the initial ledger from a fixed seed. Named accounts are explicit
 * contract anchors for the scenarios; additional seed accounts are generated
 * deterministically and never participate in matching (ledger-conservation noise).
 */
export function buildFixtures(seed: number): FixtureData {
  const rand = mulberry32(seed);

  const users: FixtureUser[] = [
    { userId: "u_alice", availableBalance: 10000, frozenBalance: 0, label: "primary bidder" },
    { userId: "u_bob", availableBalance: 10000, frozenBalance: 0, label: "primary seller" },
    { userId: "u_carol", availableBalance: 8000, frozenBalance: 0, label: "bidder and royalty recipient" },
    { userId: "u_dave", availableBalance: 5000, frozenBalance: 0, label: "collection creator / royalty recipient" },
    { userId: "u_eve", availableBalance: 300, frozenBalance: 0, label: "low-balance bidder" },
  ];
  for (let index = 1; index <= 3; index += 1) {
    const balance = 1000 + Math.floor(rand() * 4000);
    users.push({
      userId: `u_seed_${index}`,
      availableBalance: balance,
      frozenBalance: 0,
      label: `seeded background account #${index}`,
    });
  }

  const punkRecipients: readonly RoyaltyRecipient[] = [
    { userId: "u_dave", weight: 70 },
    { userId: "u_carol", weight: 30 },
  ];
  const apeRecipients: readonly RoyaltyRecipient[] = [{ userId: "u_dave", weight: 100 }];

  const collections: CollectionRow[] = [
    { collectionId: "col_punks", royaltyBps: 250, recipients: punkRecipients, version: 1 },
    { collectionId: "col_apes", royaltyBps: 1000, recipients: apeRecipients, version: 1 },
  ];

  const tokens: FixtureToken[] = [
    { tokenId: "t_punk_1", collectionId: "col_punks", ownerId: "u_bob" },
    { tokenId: "t_punk_2", collectionId: "col_punks", ownerId: "u_carol" },
    { tokenId: "t_punk_3", collectionId: "col_punks", ownerId: "u_bob" },
    { tokenId: "t_ape_1", collectionId: "col_apes", ownerId: "u_bob" },
    { tokenId: "t_ape_2", collectionId: "col_apes", ownerId: "u_bob" },
  ];

  return { users, collections, tokens, seed };
}
