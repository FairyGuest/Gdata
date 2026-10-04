export const SCHEMA_VERSION = 1;

export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE collections (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    royalty_bps       INTEGER NOT NULL CHECK (royalty_bps BETWEEN 0 AND 10000),
    royalty_recipient TEXT NOT NULL,
    soulbound         INTEGER NOT NULL DEFAULT 0 CHECK (soulbound IN (0, 1))
  );

  CREATE TABLE users (
    id      TEXT PRIMARY KEY,
    balance INTEGER NOT NULL CHECK (balance >= 0)
  );

  CREATE TABLE tokens (
    id            TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL REFERENCES collections (id),
    owner_id      TEXT NOT NULL REFERENCES users (id)
  );

  CREATE TABLE orders (
    id                 TEXT PRIMARY KEY,
    token_id           TEXT NOT NULL REFERENCES tokens (id),
    collection_id      TEXT NOT NULL REFERENCES collections (id),
    seller_id          TEXT NOT NULL REFERENCES users (id),
    price              INTEGER NOT NULL CHECK (price > 0),
    royalty_bps        INTEGER NOT NULL CHECK (royalty_bps BETWEEN 0 AND 10000),
    royalty_recipient  TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('open', 'filled', 'cancelled')),
    buyer_id           TEXT REFERENCES users (id),
    created_seq        INTEGER NOT NULL,
    commit_seq         INTEGER
  );

  -- Backstop for the duplicate-listing rule; the kernel checks first so it can
  -- return a precise 409 reason, this index makes the invariant unconditional.
  CREATE UNIQUE INDEX orders_one_open_per_token ON orders (token_id) WHERE status = 'open';

  CREATE TABLE fills (
    order_id          TEXT PRIMARY KEY REFERENCES orders (id),
    buyer_id          TEXT NOT NULL,
    seller_id         TEXT NOT NULL,
    price             INTEGER NOT NULL,
    royalty           INTEGER NOT NULL,
    seller_proceeds   INTEGER NOT NULL,
    royalty_recipient TEXT NOT NULL,
    commit_seq        INTEGER NOT NULL,
    run_id            TEXT NOT NULL
  );

  CREATE TABLE order_events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL,
    request_id TEXT NOT NULL,
    order_id   TEXT,
    transition TEXT NOT NULL,
    reason     TEXT,
    detail     TEXT
  );
  `,
];

interface UserVersionRow {
  user_version: number;
}

export function migrate(db: { exec(sql: string): void; prepare(sql: string): { get(): unknown } }): void {
  const row = db.prepare('PRAGMA user_version').get() as UserVersionRow;
  const current = row.user_version;
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version] as string);
      db.exec('PRAGMA user_version = ' + String(version + 1));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
