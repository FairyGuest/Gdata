// SQLite state adapter (node:sqlite). Persists instances and the full
// transition history with run ids, reasons and (virtual) timestamps.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  InstanceRecord,
  InstanceQuery,
  InstanceStatus,
  ResourceQuota,
  TransitionRecord,
} from '../domain/types.ts';

export class InstanceStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS instances (' +
      '  id TEXT PRIMARY KEY,' +
      '  name TEXT NOT NULL,' +
      '  template TEXT NOT NULL,' +
      '  status TEXT NOT NULL,' +
      '  resources_json TEXT NOT NULL,' +
      '  created_at INTEGER NOT NULL,' +
      '  updated_at INTEGER NOT NULL' +
      ');' +
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_instances_active_name ON instances(name) WHERE status != 'DELETED';" +
      'CREATE TABLE IF NOT EXISTS transitions (' +
      '  id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      '  instance_id TEXT NOT NULL,' +
      '  run_id TEXT NOT NULL,' +
      '  from_status TEXT,' +
      '  to_status TEXT NOT NULL,' +
      '  reason TEXT NOT NULL,' +
      '  at INTEGER NOT NULL' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_transitions_instance ON transitions(instance_id);',
    );
  }

  create(instance: InstanceRecord): void {
    this.db.prepare(
      'INSERT INTO instances (id, name, template, status, resources_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(instance.id, instance.name, instance.template, instance.status,
      JSON.stringify(instance.resources), instance.createdAt, instance.updatedAt);
  }

  updateStatus(id: string, status: InstanceStatus, updatedAt: number): void {
    this.db.prepare('UPDATE instances SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, updatedAt, id);
  }

  getById(id: string): InstanceRecord | null {
    const row = this.db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as any;
    return row ? this.toRecord(row) : null;
  }

  getByName(name: string): InstanceRecord | null {
    const row = this.db.prepare('SELECT * FROM instances WHERE name = ? ORDER BY created_at DESC LIMIT 1').get(name) as any;
    return row ? this.toRecord(row) : null;
  }

  findActiveByName(name: string): InstanceRecord | null {
    const row = this.db.prepare("SELECT * FROM instances WHERE name = ? AND status != 'DELETED' LIMIT 1").get(name) as any;
    return row ? this.toRecord(row) : null;
  }

  query(q: InstanceQuery): InstanceRecord[] {
    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (q.template) { conds.push('template = ?'); params.push(q.template); }
    if (q.status) { conds.push('status = ?'); params.push(q.status); }
    const sql = 'SELECT * FROM instances' + (conds.length ? ' WHERE ' + conds.join(' AND ') : '') + ' ORDER BY created_at';
    return (this.db.prepare(sql).all(...params) as any[]).map((r) => this.toRecord(r));
  }

  recordTransition(t: Omit<TransitionRecord, 'id'>): TransitionRecord {
    const res = this.db.prepare(
      'INSERT INTO transitions (instance_id, run_id, from_status, to_status, reason, at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(t.instanceId, t.runId, t.fromStatus, t.toStatus, t.reason, t.at);
    return { id: Number(res.lastInsertRowid), ...t };
  }

  history(instanceId: string): TransitionRecord[] {
    return (this.db.prepare('SELECT * FROM transitions WHERE instance_id = ? ORDER BY id').all(instanceId) as any[])
      .map((r) => ({
        id: r.id,
        instanceId: r.instance_id,
        runId: r.run_id,
        fromStatus: r.from_status,
        toStatus: r.to_status,
        reason: r.reason,
        at: r.at,
      }));
  }

  close(): void {
    this.db.close();
  }

  private toRecord(row: any): InstanceRecord {
    return {
      id: row.id,
      name: row.name,
      template: row.template,
      status: row.status as InstanceStatus,
      resources: JSON.parse(row.resources_json) as ResourceQuota,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
