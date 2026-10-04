import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../config.js";

export type DB = DatabaseSync;

/**
 * Serialize a unit of work in a single SQLite transaction. Concurrent feeds
 * serialize on the single writer connection; BEGIN IMMEDIATE takes the write
 * lock up front so no lost updates can occur.
 */
export function inTransaction<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function openDb(config: AppConfig): DB {
  const db = new DatabaseSync(config.dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  seedFixtures(db, config.fixtureSeed);
  return db;
}

function migrate(db: DB): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS collections (" +
      " collection_id TEXT PRIMARY KEY," +
      " template_json TEXT NOT NULL" +
      ");" +
      "CREATE TABLE IF NOT EXISTS thresholds (" +
      " collection_id TEXT NOT NULL REFERENCES collections(collection_id)," +
      " from_level INTEGER NOT NULL," +
      " xp_cost INTEGER NOT NULL," +
      " PRIMARY KEY (collection_id, from_level)" +
      ");" +
      "CREATE TABLE IF NOT EXISTS tokens (" +
      " token_id INTEGER PRIMARY KEY," +
      " collection_id TEXT NOT NULL REFERENCES collections(collection_id)," +
      " level INTEGER NOT NULL," +
      " xp INTEGER NOT NULL," +
      " total_fed INTEGER NOT NULL DEFAULT 0," +
      " total_consumed INTEGER NOT NULL DEFAULT 0" +
      ");" +
      "CREATE TABLE IF NOT EXISTS admins (" +
      " admin_id TEXT NOT NULL," +
      " collection_id TEXT NOT NULL REFERENCES collections(collection_id)," +
      " PRIMARY KEY (admin_id, collection_id)" +
      ");" +
      "CREATE TABLE IF NOT EXISTS transitions (" +
      " seq INTEGER PRIMARY KEY AUTOINCREMENT," +
      " token_id INTEGER NOT NULL REFERENCES tokens(token_id)," +
      " kind TEXT NOT NULL," +
      " amount INTEGER NOT NULL," +
      " from_level INTEGER NOT NULL," +
      " to_level INTEGER NOT NULL," +
      " xp_after INTEGER NOT NULL" +
      ");"
  );
}

/** Deterministic PRNG (LCG) so fixtures are reproducible from a fixed seed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function seedFixtures(db: DB, seed: number): void {
  const row = db.prepare("SELECT COUNT(*) AS n FROM collections").get() as { n: number };
  if (Number(row.n) > 0) return;
  const rnd = lcg(seed);
  const backgrounds = ["forest", "desert", "ocean"] as const;
  const pick = backgrounds[Math.floor(rnd() * backgrounds.length)];

  // Collection "dragons": first threshold is 7 (non-divisible ladder used by tests).
  const ladder = [7, 10, 15];
  const tiers = ["bronze", "silver", "gold", "diamond"];
  const template = {
    collectionId: "dragons",
    baseName: "Dragon",
    staticAttributes: [{ trait_type: "Background", value: pick }],
    levels: tiers.map((tier, i) => ({
      tier,
      image: "ipfs://fixtures/dragons/level-" + (i + 1) + ".png",
    })),
  };

  inTransaction(db, () => {
    db.prepare("INSERT INTO collections (collection_id, template_json) VALUES (?, ?)").run(
      "dragons",
      JSON.stringify(template),
    );
    const insTh = db.prepare("INSERT INTO thresholds (collection_id, from_level, xp_cost) VALUES (?, ?, ?)");
    ladder.forEach((cost, i) => insTh.run("dragons", i + 1, cost));
    const insTok = db.prepare(
      "INSERT INTO tokens (token_id, collection_id, level, xp) VALUES (?, ?, 1, 0)",
    );
    for (let id = 1; id <= 4; id++) insTok.run(id, "dragons");
    db.prepare("INSERT INTO admins (admin_id, collection_id) VALUES (?, ?)").run("admin-1", "dragons");
  });
}
