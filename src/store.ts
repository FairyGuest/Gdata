import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Tier = "global" | "org" | "project";

export interface ScopeRow {
  id: string;
  tier: Tier;
  quota_limit: number;
  quota_used: number;
}

export type KeyStatus = "active" | "rotated";

export interface KeyRow {
  id: string;
  key_value: string;
  global_scope_id: string;
  org_scope_id: string;
  project_scope_id: string;
  status: KeyStatus;
  created_at: number;
  grace_until: number | null;
  successor_id: string | null;
  consumed_total: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scopes (
  id          TEXT PRIMARY KEY,
  tier        TEXT NOT NULL CHECK (tier IN ('global','org','project')),
  quota_limit INTEGER NOT NULL CHECK (quota_limit >= 0),
  quota_used  INTEGER NOT NULL DEFAULT 0 CHECK (quota_used >= 0)
);
CREATE TABLE IF NOT EXISTS api_keys (
  id                TEXT PRIMARY KEY,
  key_value         TEXT NOT NULL UNIQUE,
  global_scope_id   TEXT NOT NULL REFERENCES scopes(id),
  org_scope_id      TEXT NOT NULL REFERENCES scopes(id),
  project_scope_id  TEXT NOT NULL REFERENCES scopes(id),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','rotated')),
  created_at        INTEGER NOT NULL,
  grace_until       INTEGER,
  successor_id      TEXT,
  consumed_total    INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * State adapter: owns the SQLite handle and exposes typed row access plus an
 * explicit transaction boundary. The kernel never talks SQL string literals
 * for row shape; it only sees these types.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  /**
   * Runs fn inside BEGIN IMMEDIATE ... COMMIT. BEGIN IMMEDIATE acquires the
   * write lock up front, so concurrent consumers serialize here and no
   * read-then-write race can lose updates. Any throw triggers ROLLBACK, so a
   * partially deducted 3-tier chain is impossible.
   */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  insertScope(scope: ScopeRow): void {
    this.db
      .prepare("INSERT INTO scopes (id, tier, quota_limit, quota_used) VALUES (?, ?, ?, ?)")
      .run(scope.id, scope.tier, scope.quota_limit, scope.quota_used);
  }

  getScope(id: string): ScopeRow | undefined {
    return this.db.prepare("SELECT * FROM scopes WHERE id = ?").get(id) as ScopeRow | undefined;
  }

  deductScope(id: string, amount: number): void {
    this.db
      .prepare("UPDATE scopes SET quota_used = quota_used + ? WHERE id = ?")
      .run(amount, id);
  }

  insertKey(row: KeyRow): void {
    this.db
      .prepare(
        `INSERT INTO api_keys
         (id, key_value, global_scope_id, org_scope_id, project_scope_id, status, created_at, grace_until, successor_id, consumed_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.key_value,
        row.global_scope_id,
        row.org_scope_id,
        row.project_scope_id,
        row.status,
        row.created_at,
        row.grace_until,
        row.successor_id,
        row.consumed_total,
      );
  }

  findKeyByValue(keyValue: string): KeyRow | undefined {
    return this.db
      .prepare("SELECT * FROM api_keys WHERE key_value = ?")
      .get(keyValue) as KeyRow | undefined;
  }

  markRotated(keyId: string, graceUntil: number, successorId: string): void {
    this.db
      .prepare("UPDATE api_keys SET status = 'rotated', grace_until = ?, successor_id = ? WHERE id = ?")
      .run(graceUntil, successorId, keyId);
  }

  addKeyConsumption(keyId: string, amount: number): void {
    this.db
      .prepare("UPDATE api_keys SET consumed_total = consumed_total + ? WHERE id = ?")
      .run(amount, keyId);
  }

  close(): void {
    this.db.close();
  }
}
