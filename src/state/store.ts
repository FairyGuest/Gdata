// State adapter: SQLite persistence for declarations, environments and
// snapshot history. The only module that talks to the database; the kernel
// depends on this interface, never on SQL.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import {
  Declaration,
  EnvironmentRow,
  ScopeLevel,
  SnapshotEntry,
} from '../contracts/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS declarations (
  id TEXT PRIMARY KEY,
  scope_level TEXT NOT NULL CHECK (scope_level IN ('org','project','env')),
  org TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  env TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope_level, org, project, env, name)
);
CREATE INDEX IF NOT EXISTS idx_declarations_name ON declarations (name);

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  project TEXT NOT NULL,
  env TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','deleted')),
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (org, project, env)
);
CREATE INDEX IF NOT EXISTS idx_environments_coord ON environments (org, project, env);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  source_level TEXT NOT NULL,
  source_path TEXT NOT NULL,
  declaration_id TEXT NOT NULL,
  declaration_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_env ON snapshots (environment_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_decl ON snapshots (declaration_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_name ON snapshots (name);
`;

interface DeclarationRow {
  id: string;
  scope_level: ScopeLevel;
  org: string;
  project: string | null;
  env: string | null;
  name: string;
  value: string;
  version: number;
  updated_at: string;
}

function toDeclaration(r: DeclarationRow): Declaration {
  return {
    id: r.id,
    scopeLevel: r.scope_level,
    org: r.org,
    project: r.project,
    env: r.env,
    name: r.name,
    value: r.value,
    version: r.version,
    updatedAt: r.updated_at,
  };
}

function toEnvironment(r: any): EnvironmentRow {
  return {
    id: r.id,
    org: r.org,
    project: r.project,
    env: r.env,
    status: r.status,
    createdAt: r.created_at,
    deletedAt: r.deleted_at,
  };
}

function toSnapshot(r: any): SnapshotEntry {
  return {
    id: r.id,
    environmentId: r.environment_id,
    name: r.name,
    value: r.value,
    fingerprint: r.fingerprint,
    sourceLevel: r.source_level,
    sourcePath: r.source_path,
    declarationId: r.declaration_id,
    declarationVersion: r.declaration_version,
    createdAt: r.created_at,
  };
}

export class SecretStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Run fn inside a transaction; rolls back on any throw. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  upsertDeclaration(d: Declaration): void {
    this.db.prepare(`
      INSERT INTO declarations (id, scope_level, org, project, env, name, value, version, updated_at)
      VALUES (@id, @scopeLevel, @org, @project, @env, @name, @value, @version, @updatedAt)
      ON CONFLICT (scope_level, org, project, env, name)
      DO UPDATE SET value = @value, version = declarations.version + 1, updated_at = @updatedAt
    `).run({
      id: d.id,
      scopeLevel: d.scopeLevel,
      org: d.org,
      project: d.project ?? '',
      env: d.env ?? '',
      name: d.name,
      value: d.value,
      version: d.version,
      updatedAt: d.updatedAt,
    });
  }

  getDeclaration(scopeLevel: ScopeLevel, org: string, project: string | null, env: string | null, name: string): Declaration | null {
    const row = this.db.prepare(`
      SELECT * FROM declarations
      WHERE scope_level = ? AND org = ? AND name = ?
        AND (project IS ? OR project = ?)
        AND (env IS ? OR env = ?)
    `).get(scopeLevel, org, name, project ?? '', project ?? '', env ?? '', env ?? '') as DeclarationRow | undefined;
    return row ? toDeclaration(row) : null;
  }

  /** All declarations visible from the environment scope chain (org + project + env). */
  declarationsForChain(org: string, project: string, env: string): Declaration[] {
    const rows = this.db.prepare(`
      SELECT * FROM declarations
      WHERE (scope_level = 'org' AND org = ?)
         OR (scope_level = 'project' AND org = ? AND project = ?)
         OR (scope_level = 'env' AND org = ? AND project = ? AND env = ?)
    `).all(org, org, project, org, project, env) as DeclarationRow[];
    return rows.map(toDeclaration);
  }

  deleteDeclaration(id: string): void {
    this.db.prepare('DELETE FROM declarations WHERE id = ?').run(id);
  }

  insertEnvironment(e: EnvironmentRow): void {
    this.db.prepare(`
      INSERT INTO environments (id, org, project, env, status, created_at, deleted_at)
      VALUES (@id, @org, @project, @env, @status, @createdAt, @deletedAt)
    `).run(e);
  }

  getEnvironment(org: string, project: string, env: string): EnvironmentRow | null {
    const row = this.db.prepare(
      'SELECT * FROM environments WHERE org = ? AND project = ? AND env = ?',
    ).get(org, project, env);
    return row ? toEnvironment(row) : null;
  }

  getEnvironmentById(id: string): EnvironmentRow | null {
    const row = this.db.prepare('SELECT * FROM environments WHERE id = ?').get(id);
    return row ? toEnvironment(row) : null;
  }

  markEnvironmentDeleted(id: string, deletedAt: string): void {
    this.db.prepare("UPDATE environments SET status = 'deleted', deleted_at = ? WHERE id = ?").run(deletedAt, id);
  }

  insertSnapshot(s: SnapshotEntry): void {
    this.db.prepare(`
      INSERT INTO snapshots (id, environment_id, name, value, fingerprint, source_level, source_path, declaration_id, declaration_version, created_at)
      VALUES (@id, @environmentId, @name, @value, @fingerprint, @sourceLevel, @sourcePath, @declarationId, @declarationVersion, @createdAt)
    `).run(s);
  }

  snapshotsForEnvironment(environmentId: string): SnapshotEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM snapshots WHERE environment_id = ? ORDER BY name',
    ).all(environmentId);
    return rows.map(toSnapshot);
  }

  deleteSnapshotsForEnvironment(environmentId: string): number {
    return this.db.prepare('DELETE FROM snapshots WHERE environment_id = ?').run(environmentId).changes;
  }

  /** Active environments whose snapshots still reference the given declaration. */
  activeReferencingEnvironments(declarationId: string): EnvironmentRow[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT e.* FROM snapshots s
      JOIN environments e ON e.id = s.environment_id
      WHERE s.declaration_id = ? AND e.status = 'active'
    `).all(declarationId);
    return rows.map(toEnvironment);
  }

  /** Binding relations, filterable by environment id and/or secret name. */
  queryBindings(filter: { environmentId?: string; name?: string }): Array<SnapshotEntry & { environment: EnvironmentRow }> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.environmentId) { clauses.push('s.environment_id = ?'); params.push(filter.environmentId); }
    if (filter.name) { clauses.push('s.name = ?'); params.push(filter.name); }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const rows = this.db.prepare(`
      SELECT s.*, e.id AS e_id, e.org AS e_org, e.project AS e_project, e.env AS e_env,
             e.status AS e_status, e.created_at AS e_created_at, e.deleted_at AS e_deleted_at
      FROM snapshots s JOIN environments e ON e.id = s.environment_id
      ${where} ORDER BY s.name, e.id
    `).all(...params) as any[];
    return rows.map((r) => ({
      ...toSnapshot(r),
      environment: toEnvironment({
        id: r.e_id, org: r.e_org, project: r.e_project, env: r.e_env,
        status: r.e_status, created_at: r.e_created_at, deleted_at: r.e_deleted_at,
      }),
    }));
  }
}


