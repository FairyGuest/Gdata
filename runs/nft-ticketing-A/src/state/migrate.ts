import type { DatabaseSync } from "node:sqlite";

/**
 * Idempotent schema migration. The schema deliberately keeps a UNIQUE index on
 * (session_id, seat_code) among *live* tickets as a backstop, but seat
 * uniqueness is always decided explicitly inside the kernel transaction.
 */
export function migrate(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sessions (
      session_id   TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      ticket_limit INTEGER NOT NULL CHECK (ticket_limit > 0)
    );

    CREATE TABLE IF NOT EXISTS seats (
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      seat_code  TEXT NOT NULL,
      price      INTEGER NOT NULL CHECK (price >= 0),
      PRIMARY KEY (session_id, seat_code)
    );

    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      balance INTEGER NOT NULL CHECK (balance >= 0)
    );

    -- status: held | checked_in | voided
    CREATE TABLE IF NOT EXISTS tickets (
      ticket_id       TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL REFERENCES sessions(session_id),
      seat_code       TEXT NOT NULL,
      holder_user_id  TEXT NOT NULL REFERENCES users(user_id),
      status          TEXT NOT NULL CHECK (status IN ('held','checked_in','voided')),
      issue_seq       INTEGER NOT NULL,
      checkin_seq     INTEGER,
      void_seq        INTEGER
    );

    -- Backstop uniqueness: at most one non-voided ticket per seat.
    CREATE UNIQUE INDEX IF NOT EXISTS ux_live_seat
      ON tickets(session_id, seat_code)
      WHERE status <> 'voided';

    CREATE TABLE IF NOT EXISTS ownership_log (
      seq          INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id    TEXT NOT NULL,
      action       TEXT NOT NULL CHECK (action IN ('issue','transfer','checkin','refund')),
      from_user_id TEXT,
      to_user_id   TEXT
    );

    -- One row per committed ledger transaction: the global commit ordering.
    CREATE TABLE IF NOT EXISTS commit_log (
      commit_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     TEXT NOT NULL,
      req_seq    INTEGER NOT NULL,
      action     TEXT NOT NULL,
      ok         INTEGER NOT NULL,
      reason     TEXT
    );

    -- Per-run request attempts, recorded even when the request loses/conflicts.
    CREATE TABLE IF NOT EXISTS run_attempts (
      run_id     TEXT NOT NULL,
      req_seq    INTEGER NOT NULL,
      action     TEXT NOT NULL,
      ok         INTEGER NOT NULL,
      reason     TEXT,
      commit_seq INTEGER,
      PRIMARY KEY (run_id, req_seq)
    );
  `);
}
