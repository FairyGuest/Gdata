export function migrate(db: import("node:sqlite").DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq         INTEGER PRIMARY KEY,
      type        TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      body        TEXT NOT NULL,
      commit_seq  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ownership (
      token_id TEXT PRIMARY KEY,
      owner    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projection_singleton (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      applied_seq INTEGER NOT NULL,
      volume      REAL NOT NULL,
      floor       REAL,
      last_sale   TEXT
    );
    CREATE TABLE IF NOT EXISTS rejections (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     TEXT NOT NULL,
      reason     TEXT NOT NULL,
      status     INTEGER NOT NULL,
      seq        INTEGER,
      message    TEXT NOT NULL,
      detail     TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`
    INSERT OR IGNORE INTO projection_singleton (id, applied_seq, volume, floor, last_sale)
    VALUES (1, 0, 0, NULL, NULL);
    INSERT OR IGNORE INTO meta (key, value) VALUES ('next_commit_seq', '1');
  `);
}

