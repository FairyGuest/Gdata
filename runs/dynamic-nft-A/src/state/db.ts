import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isAbsolute } from "node:path";

let nodeSqliteWarned = false;

export function openDatabase(file: string): DatabaseSync {
  let dbFile = file;
  if (dbFile !== ":memory:") {
    if (!isAbsolute(dbFile)) dbFile = new URL("../../" + dbFile, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const dir = dirname(dbFile);
    if (dir) mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  if (!nodeSqliteWarned) {
    process.emitWarning = process.emitWarning;
    nodeSqliteWarned = true;
  }
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      collection_id TEXT PRIMARY KEY,
      base_name TEXT NOT NULL,
      description TEXT NOT NULL,
      max_level INTEGER NOT NULL,
      thresholds_json TEXT NOT NULL,
      templates_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tokens (
      collection_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      level INTEGER NOT NULL,
      xp INTEGER NOT NULL,
      consumed_xp INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (collection_id, token_id),
      FOREIGN KEY (collection_id) REFERENCES collections(collection_id)
    );
    CREATE TABLE IF NOT EXISTS admins (
      collection_id TEXT NOT NULL,
      admin_id TEXT NOT NULL,
      PRIMARY KEY (collection_id, admin_id),
      FOREIGN KEY (collection_id) REFERENCES collections(collection_id)
    );
    CREATE TABLE IF NOT EXISTS feed_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      from_level INTEGER NOT NULL,
      from_xp INTEGER NOT NULL,
      to_level INTEGER NOT NULL,
      to_xp INTEGER NOT NULL,
      consumed_delta INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS level_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      from_level INTEGER NOT NULL,
      to_level INTEGER NOT NULL,
      threshold_cost INTEGER NOT NULL,
      at_feed_seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reset_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      admin_id TEXT NOT NULL,
      from_level INTEGER NOT NULL,
      from_xp INTEGER NOT NULL
    );
  `);
}

