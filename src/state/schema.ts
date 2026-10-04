import type Database from 'better-sqlite3';

export function migrate(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, name TEXT NOT NULL, seat_limit INTEGER NOT NULL CHECK (seat_limit > 0), price_cents INTEGER NOT NULL CHECK (price_cents >= 0));
    CREATE TABLE IF NOT EXISTS seats (event_id TEXT NOT NULL REFERENCES events(id), id TEXT NOT NULL, PRIMARY KEY (event_id, id));
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0));
    CREATE TABLE IF NOT EXISTS tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL REFERENCES events(id), seat_id TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), price_cents INTEGER NOT NULL CHECK (price_cents >= 0), status TEXT NOT NULL CHECK (status IN ('sold', 'checked_in', 'voided')), commit_seq INTEGER NOT NULL, version INTEGER NOT NULL CHECK (version > 0), UNIQUE(event_id, seat_id, version));
    CREATE TABLE IF NOT EXISTS active_seats (event_id TEXT NOT NULL, seat_id TEXT NOT NULL, ticket_row_id INTEGER NOT NULL, PRIMARY KEY (event_id, seat_id));
    CREATE TABLE IF NOT EXISTS ticket_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, from_user_id TEXT, to_user_id TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('issue', 'transfer', 'void', 'check_in')), commit_seq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, user_id TEXT NOT NULL, ticket_id TEXT, amount_cents INTEGER NOT NULL, commit_seq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS commit_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, action TEXT NOT NULL, ticket_id TEXT);
  `);
}
