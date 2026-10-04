import { DatabaseSync } from "node:sqlite";
import { CONFIG } from "../config.js";

export type Db = DatabaseSync;

export function openDb(path = ":memory:"): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id      TEXT PRIMARY KEY,
      balance INTEGER NOT NULL CHECK (balance >= 0)
    );
    CREATE TABLE IF NOT EXISTS tokens (
      id    TEXT PRIMARY KEY,
      owner TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS valuations (
      tick_from INTEGER PRIMARY KEY,
      value     INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loans (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      borrower      TEXT NOT NULL,
      token_id      TEXT NOT NULL,
      principal     INTEGER NOT NULL,
      per_tick_bps  INTEGER NOT NULL,
      borrow_tick   INTEGER NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('active','repaid','liquidated')),
      settle_tick   INTEGER,
      settle_seq    INTEGER
    );
  `);
}

/**
 * Deterministic fixture seed (fixed seed, no randomness, no external data):
 *  - valuation ladder: piecewise-constant steps keyed by tick
 *  - user balances and NFT ownership
 *  - global tick and commit sequence start at 0
 */
export function seedFixtures(db: Db): void {
  const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  meta.run("tick", 0);
  meta.run("commit_seq", 0);

  const acct = db.prepare("INSERT INTO accounts (id, balance) VALUES (?, ?)");
  acct.run(CONFIG.POOL_ID, 100000);
  acct.run("alice", 5000);
  acct.run("bob", 3000);
  acct.run("carol", 1000);

  const tok = db.prepare("INSERT INTO tokens (id, owner) VALUES (?, ?)");
  tok.run("nft-1", "alice");
  tok.run("nft-2", "alice");
  tok.run("nft-3", "alice");
  tok.run("nft-4", "bob");

  const val = db.prepare("INSERT INTO valuations (tick_from, value) VALUES (?, ?)");
  // Ladder: value steps down as the global tick advances.
  const ladder: Array<[number, number]> = [
    [0, 10000],
    [5, 9000],
    [10, 7000],
    [15, 5000],
    [20, 3000],
    [25, 1000],
  ];
  for (const [t, v] of ladder) val.run(t, v);
}

export function getMeta(db: Db, key: string): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: number } | undefined;
  if (!row) throw new Error("meta key missing: " + key);
  return Number(row.value);
}

/** Valuation at a given tick: latest ladder step with tick_from <= tick. */
export function valuationAt(db: Db, tick: number): number {
  const row = db
    .prepare("SELECT value FROM valuations WHERE tick_from <= ? ORDER BY tick_from DESC LIMIT 1")
    .get(tick) as { value: number } | undefined;
  if (!row) throw new Error("no valuation step for tick " + tick);
  return Number(row.value);
}
