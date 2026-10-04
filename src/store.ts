import { DatabaseSync } from 'node:sqlite';
import { VaultError } from './errors.js';

export interface VersionRow {
  name: string;
  version: number;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  key_id: string;
  created_at: number;
  expires_at: number | null;
}

export interface AuditInsert {
  ts: number;
  runId: string | null;
  op: string;
  name: string | null;
  version: number | null;
  result: 'OK' | 'ERROR';
  errorCode: string | null;
  reason: string;
}

export interface AuditRow extends AuditInsert {
  id: number;
  prevHash: string;
  hash: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  tag BLOB NOT NULL,
  key_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (name, version)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  run_id TEXT,
  op TEXT NOT NULL,
  name TEXT,
  version INTEGER,
  result TEXT NOT NULL,
  error_code TEXT,
  reason TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_no_update
BEFORE UPDATE ON audit
BEGIN
  SELECT RAISE(ABORT, 'audit log is immutable');
END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete
BEFORE DELETE ON audit
BEGIN
  SELECT RAISE(ABORT, 'audit log is immutable');
END;
`;

export class VaultStore {
  private readonly db: DatabaseSync;
  private txDepth = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  secretExists(name: string): boolean {
    const row = this.db.prepare('SELECT name FROM secrets WHERE name = ?').get(name);
    return row !== undefined;
  }

  createSecret(name: string, now: number): void {
    this.db.prepare('INSERT INTO secrets (name, created_at) VALUES (?, ?)').run(name, now);
  }

  latestVersion(name: string): number | null {
    const row = this.db
      .prepare('SELECT MAX(version) AS v FROM versions WHERE name = ?')
      .get(name) as { v: number | null };
    return row.v;
  }

  insertVersion(row: VersionRow): void {
    this.db
      .prepare(
        'INSERT INTO versions (name, version, ciphertext, iv, tag, key_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(row.name, row.version, row.ciphertext, row.iv, row.tag, row.key_id, row.created_at, row.expires_at);
  }

  getVersion(name: string, version: number): VersionRow | undefined {
    return this.db
      .prepare('SELECT * FROM versions WHERE name = ? AND version = ?')
      .get(name, version) as VersionRow | undefined;
  }

  listVersions(name: string): Array<Pick<VersionRow, 'version' | 'created_at' | 'expires_at' | 'key_id'>> {
    return this.db
      .prepare('SELECT version, created_at, expires_at, key_id FROM versions WHERE name = ? ORDER BY version')
      .all(name) as Array<Pick<VersionRow, 'version' | 'created_at' | 'expires_at' | 'key_id'>>;
  }

  expireVersionsBefore(name: string, keepVersion: number, expiresAt: number): number {
    const res = this.db
      .prepare('UPDATE versions SET expires_at = ? WHERE name = ? AND version < ? AND expires_at IS NULL')
      .run(expiresAt, name, keepVersion);
    return Number(res.changes);
  }

  lastAuditHash(): string {
    const row = this.db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get() as
      | { hash: string }
      | undefined;
    return row ? row.hash : 'GENESIS';
  }

  insertAudit(entry: AuditInsert, prevHash: string, hash: string): number {
    const res = this.db
      .prepare(
        'INSERT INTO audit (ts, run_id, op, name, version, result, error_code, reason, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(entry.ts, entry.runId, entry.op, entry.name, entry.version, entry.result, entry.errorCode, entry.reason, prevHash, hash);
    return Number(res.lastInsertRowid);
  }

  listAudit(name?: string): AuditRow[] {
    const rows = (name !== undefined
      ? this.db.prepare('SELECT * FROM audit WHERE name = ? ORDER BY id').all(name)
      : this.db.prepare('SELECT * FROM audit ORDER BY id').all()) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      ts: r.ts as number,
      runId: (r.run_id as string | null) ?? null,
      op: r.op as string,
      name: (r.name as string | null) ?? null,
      version: (r.version as number | null) ?? null,
      result: r.result as 'OK' | 'ERROR',
      errorCode: (r.error_code as string | null) ?? null,
      reason: r.reason as string,
      prevHash: r.prev_hash as string,
      hash: r.hash as string,
    }));
  }

  countAudit(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM audit').get() as { c: number };
    return row.c;
  }

  countSecrets(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM secrets').get() as { c: number };
    return row.c;
  }

  countVersions(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM versions').get() as { c: number };
    return row.c;
  }

  rawDb(): DatabaseSync {
    return this.db;
  }
}

export function assertStoreError(err: unknown): never {
  if (err instanceof VaultError) throw err;
  throw new VaultError('INTERNAL', 'store operation failed: ' + (err instanceof Error ? err.message : String(err)));
}
