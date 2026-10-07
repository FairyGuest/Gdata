import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  BindingRow,
  Environment,
  ScopeType,
  SecretDeclaration,
  SnapshotEntry,
} from "../domain/types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS declarations (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('org','project','env')),
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (scope_type, scope_id, name)
);
CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','deleted')),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  env_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  level TEXT NOT NULL,
  source_path TEXT NOT NULL,
  declaration_id TEXT NOT NULL,
  declaration_version INTEGER NOT NULL,
  value TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_env ON snapshots(env_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_name ON snapshots(name);
CREATE INDEX IF NOT EXISTS idx_snapshots_decl ON snapshots(declaration_id);
`;

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  upsertDeclaration(decl: SecretDeclaration): void {
    this.db
      .prepare(
        `INSERT INTO declarations (id, scope_type, scope_id, name, value, version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope_type, scope_id, name)
         DO UPDATE SET value = excluded.value, version = declarations.version + 1`,
      )
      .run(decl.id, decl.scopeType, decl.scopeId, decl.name, decl.value, decl.version, decl.createdAt);
  }

  getDeclaration(scopeType: ScopeType, scopeId: string, name: string): SecretDeclaration | null {
    const row = this.db
      .prepare("SELECT * FROM declarations WHERE scope_type = ? AND scope_id = ? AND name = ?")
      .get(scopeType, scopeId, name) as Record<string, unknown> | undefined;
    return row ? mapDeclaration(row) : null;
  }

  getDeclarationById(id: string): SecretDeclaration | null {
    const row = this.db.prepare("SELECT * FROM declarations WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapDeclaration(row) : null;
  }

  deleteDeclaration(id: string): void {
    this.db.prepare("DELETE FROM declarations WHERE id = ?").run(id);
  }

  declarationsForChain(orgId: string, projectId: string, envId: string): SecretDeclaration[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM declarations
         WHERE (scope_type = 'org' AND scope_id = ?)
            OR (scope_type = 'project' AND scope_id = ?)
            OR (scope_type = 'env' AND scope_id = ?)`,
      )
      .all(orgId, projectId, envId) as Record<string, unknown>[];
    return rows.map(mapDeclaration);
  }

  createEnvironment(env: Environment): void {
    this.db
      .prepare(
        "INSERT INTO environments (id, org_id, project_id, name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(env.id, env.orgId, env.projectId, env.name, env.status, env.createdAt);
  }

  getEnvironment(id: string): Environment | null {
    const row = this.db.prepare("SELECT * FROM environments WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapEnvironment(row) : null;
  }

  markEnvironmentDeleted(id: string, deletedAt: string): void {
    this.db.prepare("UPDATE environments SET status = 'deleted', deleted_at = ? WHERE id = ?").run(deletedAt, id);
  }

  deleteSnapshotsForEnvironment(envId: string): void {
    this.db.prepare("DELETE FROM snapshots WHERE env_id = ?").run(envId);
  }

  insertSnapshot(entry: SnapshotEntry & { id: string }): void {
    this.db
      .prepare(
        `INSERT INTO snapshots (id, env_id, name, level, source_path, declaration_id, declaration_version, value, fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.envId,
        entry.name,
        entry.level,
        entry.sourcePath,
        entry.declarationId,
        entry.declarationVersion,
        entry.value,
        entry.fingerprint,
        entry.createdAt,
      );
  }

  snapshotsForEnvironment(envId: string): SnapshotEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM snapshots WHERE env_id = ? ORDER BY name")
      .all(envId) as Record<string, unknown>[];
    return rows.map(mapSnapshot);
  }

  /** Active environments whose snapshots reference the given declaration. */
  activeReferencesForDeclaration(declarationId: string): { envId: string; envName: string; name: string }[] {
    const rows = this.db
      .prepare(
        `SELECT s.env_id AS env_id, e.name AS env_name, s.name AS name
         FROM snapshots s JOIN environments e ON e.id = s.env_id
         WHERE s.declaration_id = ? AND e.status = 'active'`,
      )
      .all(declarationId) as Record<string, unknown>[];
    return rows.map((r) => ({
      envId: String(r.env_id),
      envName: String(r.env_name),
      name: String(r.name),
    }));
  }

  queryBindings(filter: { envId?: string; name?: string }): BindingRow[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.envId) {
      clauses.push("s.env_id = ?");
      params.push(filter.envId);
    }
    if (filter.name) {
      clauses.push("s.name = ?");
      params.push(filter.name);
    }
    const where = clauses.length > 0 ? "WHERE " + clauses.join(" AND ") : "";
    const rows = this.db
      .prepare(
        `SELECT s.env_id, e.name AS env_name, e.status AS env_status, s.name, s.level,
                s.source_path, s.declaration_id, s.declaration_version, s.fingerprint
         FROM snapshots s JOIN environments e ON e.id = s.env_id ${where}
         ORDER BY s.env_id, s.name`,
      )
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      envId: String(r.env_id),
      envName: String(r.env_name),
      envStatus: r.env_status as Environment["status"],
      name: String(r.name),
      level: r.level as ScopeType,
      sourcePath: String(r.source_path),
      declarationId: String(r.declaration_id),
      declarationVersion: Number(r.declaration_version),
      fingerprint: String(r.fingerprint),
    }));
  }
}

function mapDeclaration(r: Record<string, unknown>): SecretDeclaration {
  return {
    id: String(r.id),
    scopeType: r.scope_type as ScopeType,
    scopeId: String(r.scope_id),
    name: String(r.name),
    value: String(r.value),
    version: Number(r.version),
    createdAt: String(r.created_at),
  };
}

function mapEnvironment(r: Record<string, unknown>): Environment {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    projectId: String(r.project_id),
    name: String(r.name),
    status: r.status as Environment["status"],
    createdAt: String(r.created_at),
  };
}

function mapSnapshot(r: Record<string, unknown>): SnapshotEntry {
  return {
    envId: String(r.env_id),
    name: String(r.name),
    level: r.level as ScopeType,
    sourcePath: String(r.source_path),
    declarationId: String(r.declaration_id),
    declarationVersion: Number(r.declaration_version),
    value: String(r.value),
    fingerprint: String(r.fingerprint),
    createdAt: String(r.created_at),
  };
}
