import Database from "better-sqlite3";
import { VaultError } from "./errors.ts";
import type { Ciphertext } from "./crypto.ts";

export interface VersionRow {
  version: number;
  name: string;
  ciphertext: string;
  iv: string;
  tag: string;
  keyId: string;
  createdAt: number;
  /** null while the version is fully valid; otherwise the ms-epoch end of its grace window */
  graceUntil: number | null;
}

export interface AuditEntry {
  id: number;
  runId: string;
  ts: number;
  actor: string;
  action: string;
  name: string | null;
  version: number | null;
  result: "success" | "failure";
  errorCode: string | null;
  detail: string | null;
}

export interface AuditInput {
  runId: string;
  ts: number;
  actor: string;
  action: string;
  name: string | null;
  version: number | null;
  result: "success" | "failure";
  errorCode: string | null;
  detail: string | null;
}

export type AuditDecision = Pick<AuditInput, "result" | "errorCode" | "detail">;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS secret_versions (
  name TEXT NOT NULL REFERENCES secrets(name),
  version INTEGER NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  key_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  grace_until INTEGER,
  PRIMARY KEY (name, version)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  name TEXT,
  version INTEGER,
  result TEXT NOT NULL CHECK (result IN ('success','failure')),
  error_code TEXT,
  detail TEXT
);
-- Audit log is append-only: updates and deletes are rejected at the storage layer.
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is immutable'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is immutable'); END;
`;

/**
 * State adapter. Owns the SQLite schema and guarantees that every business
 * mutation and its audit record commit in the SAME transaction.
 */
export class SqliteStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    try {
      this.db = new Database(path);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.exec(SCHEMA);
    } catch (err) {
      throw new VaultError("STORAGE_ERROR", `failed to open database: ${(err as Error).message}`);
    }
  }

  /** Run fn inside a transaction; any throw (incl. audit failure) rolls everything back. */
  private inTx<T>(fn: () => T): T {
    try {
      return this.db.transaction(fn)();
    } catch (err) {
      if (err instanceof VaultError) throw err;
      const msg = (err as Error).message ?? String(err);
      if (/audit/i.test(msg)) {
        throw new VaultError("AUDIT_ERROR", `audit write failed, operation rolled back: ${msg}`);
      }
      throw new VaultError("STORAGE_ERROR", `storage operation failed: ${msg}`);
    }
  }

  private insertAudit(entry: AuditInput): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (run_id, ts, actor, action, name, version, result, error_code, detail)
         VALUES (@runId, @ts, @actor, @action, @name, @version, @result, @errorCode, @detail)`
      )
      .run(entry);
  }

  /** Atomically: create secret if needed, insert new version, write audit. */
  putVersion(name: string, payload: Ciphertext, now: number, audit: Omit<AuditInput, "version">): number {
    return this.inTx(() => {
      this.db.prepare("INSERT OR IGNORE INTO secrets (name, created_at) VALUES (?, ?)").run(name, now);
      const row = this.db
        .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM secret_versions WHERE name = ?")
        .get(name) as { v: number };
      this.db
        .prepare(
          `INSERT INTO secret_versions (name, version, ciphertext, iv, tag, key_id, created_at, grace_until)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(name, row.v, payload.ciphertext, payload.iv, payload.tag, payload.keyId, now);
      this.insertAudit({ ...audit, version: row.v });
      return row.v;
    });
  }

  /**
   * Atomically: fetch a version row and write ONE audit row whose outcome is
   * decided by the caller's `decide` callback (so expired/missing reads are
   * audited as failures, not successes). version=null means latest.
   */
  getVersionAudited(
    name: string,
    version: number | null,
    auditBase: Omit<AuditInput, "version" | "result" | "errorCode" | "detail">,
    decide: (row: VersionRow | null) => AuditDecision
  ): VersionRow | null {
    return this.inTx(() => {
      const row = (
        version === null
          ? this.db
              .prepare("SELECT * FROM secret_versions WHERE name = ? ORDER BY version DESC LIMIT 1")
              .get(name)
          : this.db.prepare("SELECT * FROM secret_versions WHERE name = ? AND version = ?").get(name, version)
      ) as Record<string, unknown> | undefined;
      const mapped = row ? mapRow(row) : null;
      const decision = decide(mapped);
      this.insertAudit({ ...auditBase, ...decision, version: mapped ? mapped.version : version });
      return mapped;
    });
  }

  /** Standalone audit insert (own transaction) for failures before any row exists. */
  recordAudit(entry: AuditInput): void {
    this.inTx(() => this.insertAudit(entry));
  }

  /** Atomically: append rotated version, set grace deadline on older versions, audit. */
  rotate(name: string, payload: Ciphertext, now: number, graceUntil: number, audit: Omit<AuditInput, "version">): number {
    return this.inTx(() => {
      const row = this.db
        .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM secret_versions WHERE name = ?")
        .get(name) as { v: number };
      this.db
        .prepare(
          `INSERT INTO secret_versions (name, version, ciphertext, iv, tag, key_id, created_at, grace_until)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(name, row.v, payload.ciphertext, payload.iv, payload.tag, payload.keyId, now);
      this.db
        .prepare("UPDATE secret_versions SET grace_until = ? WHERE name = ? AND version < ?")
        .run(graceUntil, name, row.v);
      this.insertAudit({ ...audit, version: row.v });
      return row.v;
    });
  }

  latestVersionNumber(name: string): number | null {
    const row = this.db.prepare("SELECT MAX(version) AS v FROM secret_versions WHERE name = ?").get(name) as { v: number | null };
    return row.v;
  }

  listVersions(name: string): Array<Omit<VersionRow, "ciphertext" | "iv" | "tag">> {
    const rows = this.db
      .prepare("SELECT name, version, key_id, created_at, grace_until FROM secret_versions WHERE name = ? ORDER BY version")
      .all(name) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      name: r.name as string,
      version: r.version as number,
      keyId: r.key_id as string,
      createdAt: r.created_at as number,
      graceUntil: (r.grace_until as number | null) ?? null,
    }));
  }

  listAudit(name?: string): AuditEntry[] {
    const rows = (
      name
        ? this.db.prepare("SELECT * FROM audit_log WHERE name = ? ORDER BY id").all(name)
        : this.db.prepare("SELECT * FROM audit_log ORDER BY id").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      runId: r.run_id as string,
      ts: r.ts as number,
      actor: r.actor as string,
      action: r.action as string,
      name: (r.name as string | null) ?? null,
      version: (r.version as number | null) ?? null,
      result: r.result as "success" | "failure",
      errorCode: (r.error_code as string | null) ?? null,
      detail: (r.detail as string | null) ?? null,
    }));
  }

  /** Diagnostics-only raw access used by tests/acceptance to probe immutability. */
  rawExec(sql: string): void {
    this.db.exec(sql);
  }

  counts(): { secrets: number; versions: number; audit: number } {
    const q = (s: string) => (this.db.prepare(s).get() as { c: number }).c;
    return {
      secrets: q("SELECT COUNT(*) AS c FROM secrets"),
      versions: q("SELECT COUNT(*) AS c FROM secret_versions"),
      audit: q("SELECT COUNT(*) AS c FROM audit_log"),
    };
  }

  close(): void {
    this.db.close();
  }
}

function mapRow(r: Record<string, unknown>): VersionRow {
  return {
    name: r.name as string,
    version: r.version as number,
    ciphertext: r.ciphertext as string,
    iv: r.iv as string,
    tag: r.tag as string,
    keyId: r.key_id as string,
    createdAt: r.created_at as number,
    graceUntil: (r.grace_until as number | null) ?? null,
  };
}
