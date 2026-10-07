// State adapter: SQLite persistence for environments, status transitions, audit log.
// Full history is kept; rows are never deleted, only transitioned.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EffectiveConfig } from '../contract/template.ts';

export type EnvStatus = 'deploying' | 'active' | 'reclaimed' | 'deleted';

export const ACTIVE_STATUSES: EnvStatus[] = ['deploying', 'active'];

export interface EnvironmentRow {
  id: string;
  branch: string;
  owner: string;
  config: EffectiveConfig;
  ttlSeconds: number;
  status: EnvStatus;
  createdAt: number;
  expiresAt: number;
  renewed: boolean;
}

export interface TransitionRow {
  envId: string;
  fromStatus: string;
  toStatus: string;
  at: number;
  reason: string;
}

export interface AuditRow {
  envId: string;
  action: string;
  at: number;
  actor: string;
  reason: string;
  details: Record<string, unknown>;
}

interface RawRow {
  id: string;
  branch: string;
  owner: string;
  config_json: string;
  ttl_seconds: number;
  status: string;
  created_at: number;
  expires_at: number;
  renewed: number;
}

function toRow(r: RawRow): EnvironmentRow {
  return {
    id: r.id,
    branch: r.branch,
    owner: r.owner,
    config: JSON.parse(r.config_json) as EffectiveConfig,
    ttlSeconds: r.ttl_seconds,
    status: r.status as EnvStatus,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    renewed: r.renewed === 1,
  };
}

export class EnvironmentStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS environments (
        id TEXT PRIMARY KEY,
        branch TEXT NOT NULL,
        owner TEXT NOT NULL,
        config_json TEXT NOT NULL,
        ttl_seconds INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        renewed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_env_branch ON environments(branch, status);
      CREATE INDEX IF NOT EXISTS idx_env_owner ON environments(owner, status);
      CREATE TABLE IF NOT EXISTS transitions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        env_id TEXT NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        at INTEGER NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        env_id TEXT NOT NULL,
        action TEXT NOT NULL,
        at INTEGER NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        details_json TEXT NOT NULL
      );
    `);
  }

  insert(env: EnvironmentRow): void {
    this.db.prepare(`
      INSERT INTO environments (id, branch, owner, config_json, ttl_seconds, status, created_at, expires_at, renewed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(env.id, env.branch, env.owner, JSON.stringify(env.config), env.ttlSeconds,
      env.status, env.createdAt, env.expiresAt, env.renewed ? 1 : 0);
    this.recordTransition(env.id, 'none', env.status, env.createdAt, 'created');
  }

  get(id: string): EnvironmentRow | undefined {
    const r = this.db.prepare('SELECT * FROM environments WHERE id = ?').get(id) as RawRow | undefined;
    return r ? toRow(r) : undefined;
  }

  findActiveByBranch(branch: string): EnvironmentRow | undefined {
    const r = this.db.prepare(
      `SELECT * FROM environments WHERE branch = ? AND status IN ('deploying','active') ORDER BY created_at DESC LIMIT 1`,
    ).get(branch) as RawRow | undefined;
    return r ? toRow(r) : undefined;
  }

  listActiveByOwner(owner: string): EnvironmentRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM environments WHERE owner = ? AND status IN ('deploying','active') ORDER BY created_at`,
    ).all(owner) as unknown as RawRow[];
    return rows.map(toRow);
  }

  list(filter: { branch?: string; status?: EnvStatus }): EnvironmentRow[] {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (filter.branch !== undefined) { clauses.push('branch = ?'); args.push(filter.branch); }
    if (filter.status !== undefined) { clauses.push('status = ?'); args.push(filter.status); }
    const where = clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = this.db.prepare(`SELECT * FROM environments${where} ORDER BY created_at`)
      .all(...args) as unknown as RawRow[];
    return rows.map(toRow);
  }

  listDeployingReady(nowMs: number, deploySeconds: number): EnvironmentRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM environments WHERE status = 'deploying' AND created_at + ? * 1000 <= ?`,
    ).all(deploySeconds, nowMs) as unknown as RawRow[];
    return rows.map(toRow);
  }

  listExpired(nowMs: number): EnvironmentRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM environments WHERE status = 'active' AND expires_at <= ?`,
    ).all(nowMs) as unknown as RawRow[];
    return rows.map(toRow);
  }

  updateStatus(id: string, to: EnvStatus, at: number, reason: string): void {
    const current = this.get(id);
    if (!current) throw new Error(`updateStatus: environment ${id} not found`);
    this.db.prepare('UPDATE environments SET status = ? WHERE id = ?').run(to, id);
    this.recordTransition(id, current.status, to, at, reason);
  }

  extendExpiry(id: string, newExpiresAt: number, at: number): void {
    this.db.prepare('UPDATE environments SET expires_at = ?, renewed = 1 WHERE id = ?').run(newExpiresAt, id);
    this.recordTransition(id, 'active', 'active', at, 'renewed');
  }

  audit(entry: AuditRow): void {
    this.db.prepare(`
      INSERT INTO audit_log (env_id, action, at, actor, reason, details_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(entry.envId, entry.action, entry.at, entry.actor, entry.reason, JSON.stringify(entry.details));
  }

  listAudit(envId?: string): AuditRow[] {
    const rows = (envId === undefined
      ? this.db.prepare('SELECT * FROM audit_log ORDER BY seq').all()
      : this.db.prepare('SELECT * FROM audit_log WHERE env_id = ? ORDER BY seq').all(envId)
    ) as unknown as { env_id: string; action: string; at: number; actor: string; reason: string; details_json: string }[];
    return rows.map((r) => ({
      envId: r.env_id, action: r.action, at: r.at, actor: r.actor, reason: r.reason,
      details: JSON.parse(r.details_json) as Record<string, unknown>,
    }));
  }

  listTransitions(envId: string): TransitionRow[] {
    const rows = this.db.prepare('SELECT * FROM transitions WHERE env_id = ? ORDER BY seq').all(envId) as unknown as
      { env_id: string; from_status: string; to_status: string; at: number; reason: string }[];
    return rows.map((r) => ({ envId: r.env_id, fromStatus: r.from_status, toStatus: r.to_status, at: r.at, reason: r.reason }));
  }

  private recordTransition(envId: string, from: string, to: string, at: number, reason: string): void {
    this.db.prepare(`
      INSERT INTO transitions (env_id, from_status, to_status, at, reason) VALUES (?, ?, ?, ?, ?)
    `).run(envId, from, to, at, reason);
  }

  close(): void { this.db.close(); }
}
