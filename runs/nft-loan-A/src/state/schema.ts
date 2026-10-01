import type { SqliteDb } from './sqlite.js';

export function migrate(db: SqliteDb): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS balances (
      account TEXT PRIMARY KEY,
      amount INTEGER NOT NULL CHECK (amount >= 0)
    );
    CREATE TABLE IF NOT EXISTS nfts (
      token_id TEXT PRIMARY KEY,
      holder TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS valuation_tiers (
      token_id TEXT NOT NULL,
      start_tick INTEGER NOT NULL,
      value INTEGER NOT NULL CHECK (value >= 0),
      PRIMARY KEY (token_id, start_tick)
    );
    CREATE TABLE IF NOT EXISTS loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      borrower TEXT NOT NULL,
      token_id TEXT NOT NULL,
      principal INTEGER NOT NULL,
      opened_tick INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','repaid','liquidated')),
      settled_tick INTEGER,
      settle_commit_seq INTEGER
    );
    CREATE TABLE IF NOT EXISTS commit_log (
      seq INTEGER PRIMARY KEY,
      run_id TEXT NOT NULL,
      tick INTEGER NOT NULL,
      action TEXT NOT NULL,
      loan_id INTEGER,
      result TEXT NOT NULL,
      reason TEXT,
      detail TEXT NOT NULL
    );
  `);
  db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('tick', 0);
  db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('commit_seq', 0);
}

