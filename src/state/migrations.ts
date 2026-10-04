/**
 * SQLite schema migrations. The user_version pragma identifies the applied
 * revision; every revision is applied in one forward transaction.
 */

import type { DatabaseSync } from 'node:sqlite';

export const CURRENT_SCHEMA_VERSION = 1;

export function migrate(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const current = Number(row?.user_version ?? 0);
  if (current >= CURRENT_SCHEMA_VERSION) return current;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (current < 1) applyRevision1(db);
    db.prepare('PRAGMA user_version = ' + CURRENT_SCHEMA_VERSION).get();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return CURRENT_SCHEMA_VERSION;
}

function applyRevision1(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE collections (
      id TEXT PRIMARY KEY,
      royalty_bps INTEGER NOT NULL CHECK (royalty_bps BETWEEN 0 AND 10000),
      royalty_recipient TEXT NOT NULL,
      soulbound INTEGER NOT NULL CHECK (soulbound IN (0, 1)),
      version INTEGER NOT NULL CHECK (version >= 1)
    ) STRICT;

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      balance INTEGER NOT NULL CHECK (balance >= 0)
    ) STRICT;

    CREATE TABLE tokens (
      collection_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      PRIMARY KEY (collection_id, token_id),
      FOREIGN KEY (collection_id) REFERENCES collections(id),
      FOREIGN KEY (owner) REFERENCES users(id)
    ) STRICT;

    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      seller TEXT NOT NULL,
      buyer TEXT,
      price INTEGER NOT NULL CHECK (price > 0),
      status TEXT NOT NULL CHECK (status IN ('active', 'filled', 'cancelled')),
      royalty_bps_snapshot INTEGER NOT NULL
        CHECK (royalty_bps_snapshot BETWEEN 0 AND 10000),
      royalty_recipient_snapshot TEXT NOT NULL,
      soulbound_snapshot INTEGER NOT NULL CHECK (soulbound_snapshot IN (0, 1)),
      created_commit_seq INTEGER NOT NULL,
      filled_commit_seq INTEGER,
      cancelled_commit_seq INTEGER,
      FOREIGN KEY (collection_id) REFERENCES collections(id),
      FOREIGN KEY (seller) REFERENCES users(id),
      FOREIGN KEY (buyer) REFERENCES users(id)
    ) STRICT;

    CREATE UNIQUE INDEX idx_one_active_order
      ON orders (collection_id, token_id)
      WHERE status = 'active';

    CREATE TABLE commit_sequence (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      value INTEGER NOT NULL CHECK (value >= 0)
    ) STRICT;

    INSERT INTO commit_sequence (singleton, value) VALUES (1, 0);

    CREATE TABLE commit_log (
      seq INTEGER PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      detail_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      commit_seq INTEGER NOT NULL,
      order_id TEXT NOT NULL,
      account_user TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
      amount INTEGER NOT NULL CHECK (amount >= 0),
      classification TEXT NOT NULL,
      FOREIGN KEY (commit_seq) REFERENCES commit_log(seq),
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (account_user) REFERENCES users(id)
    ) STRICT;

    CREATE INDEX idx_orders_status_token ON orders (status, collection_id, token_id);
    CREATE INDEX idx_transfers_commit ON transfers (commit_seq);
  `);
}