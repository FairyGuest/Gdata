import type { Ledger } from "./state/db.js";

/** Deterministic PRNG (mulberry32) so the initial ledger is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seed the initial ledger from a fixed seed: collections with royalty
 * configs, token ownership and user balances. Purely local synthetic data;
 * no external accounts or real business data involved.
 */
export function seedFixtures(ledger: Ledger, seed: number): void {
  if (ledger.listCollections().length > 0) return;
  const rng = mulberry32(seed);
  const pick = (n: number) => Math.floor(rng() * n);

  const users = ["buyer-1", "buyer-2", "seller-1", "seller-2"];
  const balances: Record<string, number> = {
    "buyer-1": 50000 + pick(1000),
    "buyer-2": 2000 + pick(500),
    "seller-1": 1000 + pick(200),
    "seller-2": 800 + pick(200),
  };

  const collections = [
    { id: "col-alpha", name: "Alpha Punks", royaltyBps: 250, royaltyRecipient: "royalty-alpha" },
    { id: "col-beta", name: "Beta Apes", royaltyBps: 500, royaltyRecipient: "royalty-beta" },
  ];

  const tokens: { id: string; collectionId: string; ownerId: string }[] = [];
  for (let i = 1; i <= 6; i++) {
    tokens.push({
      id: "alpha-" + i,
      collectionId: "col-alpha",
      ownerId: i % 2 === 1 ? "seller-1" : "seller-2",
    });
  }
  for (let i = 1; i <= 4; i++) {
    tokens.push({
      id: "beta-" + i,
      collectionId: "col-beta",
      ownerId: i % 2 === 1 ? "seller-1" : "seller-2",
    });
  }

  ledger.runTx(() => {
    const insCollection = ledger.db.prepare(
      "INSERT INTO collections (id, name, royalty_bps, royalty_recipient) VALUES (?, ?, ?, ?)",
    );
    for (const c of collections) insCollection.run(c.id, c.name, c.royaltyBps, c.royaltyRecipient);
    const insAccount = ledger.db.prepare(
      "INSERT INTO accounts (user_id, available, frozen) VALUES (?, ?, 0)",
    );
    for (const u of users) insAccount.run(u, balances[u] ?? 0);
    for (const c of collections) insAccount.run(c.royaltyRecipient, 0);
    const insToken = ledger.db.prepare(
      "INSERT INTO tokens (id, collection_id, owner_id) VALUES (?, ?, ?)",
    );
    for (const t of tokens) insToken.run(t.id, t.collectionId, t.ownerId);
  });
}
