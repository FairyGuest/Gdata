// State adapter: SQLite-backed persistence for environments, state
// transitions and the audit log. Full history is retained; the environments
// table holds the current projection, environment_events the transitions.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditEvent, Environment, EnvStatus, StateTransition } from '../contract/types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  owner TEXT NOT NULL,
  template_name TEXT NOT NULL,
  params_json TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL,
  renewals_used INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_env_branch ON environments(branch);
CREATE INDEX IF NOT EXISTS idx_env_status ON environments(status);
CREATE INDEX IF NOT EXISTS idx_env_owner ON environments(owner);

CREATE TABLE IF NOT EXISTS environment_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  env_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  at INTEGER NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  env_id TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT NOT NULL,
  details_json TEXT NOT NULL
);
`;

interface EnvRow {
  id: string; branch: string; owner: string; template_name: string;
  params_json: string; params_hash: string; status: string;
  ttl_seconds: number; renewals_used: number;
  created_at: number; expires_at: number; updated_at: number;
}

function rowToEnv(row: EnvRow): Environment {
  return {
    id: row.id,
    branch: row.branch,
    owner: row.owner,
    templateName: row.template_name,
    params: JSON.parse(row.params_json),
    paramsHash: row.params_hash,
    status: row.status as EnvStatus,
    ttlSeconds: row.ttl_seconds,
    renewalsUsed: row.renewals_used,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

export class EnvironmentStore {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  insertEnv(env: Environment): void {
    this.db.prepare(`INSERT INTO environments
      (id, branch, owner, template_name, params_json, params_hash, status, ttl_seconds, renewals_used, created_at, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      env.id, env.branch, env.owner, env.templateName, JSON.stringify(env.params),
      env.paramsHash, env.status, env.ttlSeconds, env.renewalsUsed,
      env.createdAt, env.expiresAt, env.updatedAt,
    );
  }

  updateEnv(env: Environment): void {
    this.db.prepare(`UPDATE environments SET
      status = ?, ttl_seconds = ?, renewals_used = ?, expires_at = ?, updated_at = ?
      WHERE id = ?`).run(env.status, env.ttlSeconds, env.renewalsUsed, env.expiresAt, env.updatedAt, env.id);
  }

  getEnv(id: string): Environment | null {
    const row = this.db.prepare('SELECT * FROM environments WHERE id = ?').get(id) as EnvRow | undefined;
    return row ? rowToEnv(row) : null;
  }

  findOccupyingByBranch(branch: string, occupying: readonly EnvStatus[]): Environment | null {
    const marks = occupying.map(() => '?').join(',');
    const row = this.db.prepare(`SELECT * FROM environments WHERE branch = ? AND status IN (${marks}) ORDER BY created_at DESC LIMIT 1`)
      .get(branch, ...occupying) as EnvRow | undefined;
    return row ? rowToEnv(row) : null;
  }

  countOccupyingByOwner(owner: string, occupying: readonly EnvStatus[]): number {
    const marks = occupying.map(() => '?').join(',');
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM environments WHERE owner = ? AND status IN (${marks})`)
      .get(owner, ...occupying) as { n: number };
    return row.n;
  }

  listExpired(now: number, occupying: readonly EnvStatus[]): Environment[] {
    const marks = occupying.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM environments WHERE status IN (${marks}) AND expires_at <= ?`)
      .all(...occupying, now) as unknown as EnvRow[];
    return rows.map(rowToEnv);
  }

  query(filter: { branch?: string; status?: EnvStatus }): Environment[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (filter.branch !== undefined) { clauses.push('branch = ?'); args.push(filter.branch); }
    if (filter.status !== undefined) { clauses.push('status = ?'); args.push(filter.status); }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = this.db.prepare('SELECT * FROM environments' + where + ' ORDER BY created_at ASC')
      .all(...args) as unknown as EnvRow[];
    return rows.map(rowToEnv);
  }

  recordTransition(t: StateTransition): void {
    this.db.prepare('INSERT INTO environment_events (env_id, from_status, to_status, at, reason) VALUES (?, ?, ?, ?, ?)')
      .run(t.envId, t.from, t.to, t.at, t.reason);
  }

  transitions(envId: string): StateTransition[] {
    const rows = this.db.prepare('SELECT * FROM environment_events WHERE env_id = ? ORDER BY seq ASC')
      .all(envId) as unknown as Array<{ env_id: string; from_status: string | null; to_status: string; at: number; reason: string }>;
    return rows.map((r) => ({ envId: r.env_id, from: r.from_status as EnvStatus | null, to: r.to_status as EnvStatus, at: r.at, reason: r.reason }));
  }

  audit(event: Omit<AuditEvent, 'seq'>): void {
    this.db.prepare('INSERT INTO audit_log (run_id, at, env_id, action, outcome, reason, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(event.runId, event.at, event.envId, event.action, event.outcome, event.reason, JSON.stringify(event.details));
  }

  auditLog(filter: { envId?: string; action?: string } = {}): AuditEvent[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (filter.envId !== undefined) { clauses.push('env_id = ?'); args.push(filter.envId); }
    if (filter.action !== undefined) { clauses.push('action = ?'); args.push(filter.action); }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = this.db.prepare('SELECT * FROM audit_log' + where + ' ORDER BY seq ASC')
      .all(...args) as unknown as Array<{ seq: number; run_id: string; at: number; env_id: string | null; action: string; outcome: string; reason: string; details_json: string }>;
    return rows.map((r) => ({
      seq: r.seq, runId: r.run_id, at: r.at, envId: r.env_id, action: r.action,
      outcome: r.outcome as 'ALLOW' | 'DENY', reason: r.reason, details: JSON.parse(r.details_json),
    }));
  }
}

