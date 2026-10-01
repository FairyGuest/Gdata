export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  user_id           TEXT PRIMARY KEY,
  available_balance INTEGER NOT NULL CHECK (available_balance >= 0),
  frozen_balance    INTEGER NOT NULL CHECK (frozen_balance >= 0)
);

CREATE TABLE IF NOT EXISTS collections (
  collection_id   TEXT PRIMARY KEY,
  royalty_bps     INTEGER NOT NULL CHECK (royalty_bps BETWEEN 0 AND 10000),
  recipients_json TEXT NOT NULL,
  version         INTEGER NOT NULL CHECK (version >= 1),
  updated_seq     INTEGER
);

CREATE TABLE IF NOT EXISTS tokens (
  token_id      TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(collection_id),
  owner_id      TEXT NOT NULL REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS commit_log (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL,
  op           TEXT NOT NULL,
  bid_id       TEXT,
  status_from  TEXT,
  status_to    TEXT,
  detail_json  TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS bids (
  bid_id                   TEXT PRIMARY KEY,
  collection_id            TEXT NOT NULL REFERENCES collections(collection_id),
  bidder_id                TEXT NOT NULL REFERENCES users(user_id),
  amount                   INTEGER NOT NULL CHECK (amount > 0),
  status                   TEXT NOT NULL CHECK (status IN ('active','filled','cancelled')),
  royalty_bps_snapshot     INTEGER NOT NULL,
  recipients_snapshot_json TEXT NOT NULL,
  created_commit_seq       INTEGER NOT NULL,
  filled_commit_seq        INTEGER,
  cancelled_commit_seq     INTEGER,
  fill_token_id            TEXT,
  fill_seller_id           TEXT,
  seller_amount            INTEGER,
  royalty_amount           INTEGER
);

CREATE TABLE IF NOT EXISTS royalty_payments (
  payment_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  commit_seq     INTEGER NOT NULL,
  bid_id         TEXT NOT NULL,
  payee_user_id  TEXT NOT NULL REFERENCES users(user_id),
  amount         INTEGER NOT NULL CHECK (amount >= 0)
);

CREATE TABLE IF NOT EXISTS balance_movements (
  movement_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  commit_seq     INTEGER NOT NULL,
  run_id         TEXT NOT NULL,
  bid_id         TEXT,
  user_id        TEXT NOT NULL,
  delta_available INTEGER NOT NULL,
  delta_frozen   INTEGER NOT NULL,
  kind           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bids_collection ON bids(collection_id, status);
CREATE INDEX IF NOT EXISTS idx_royalty_bid ON royalty_payments(bid_id);
CREATE INDEX IF NOT EXISTS idx_movements_run ON balance_movements(run_id);
`;

export function migrate(db: { exec: (sql: string) => void; prepare: (sql: string) => { get: () => unknown } }, toVersion = SCHEMA_VERSION): void {
  const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (current >= toVersion) return;
  db.exec(SCHEMA_SQL);
  db.exec(`PRAGMA user_version = ${toVersion}`);
}
