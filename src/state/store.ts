import type { DatabaseSync } from 'node:sqlite';
import type { InstanceRow, InstanceState, TransitionRow } from './db.ts';
import type { TemplateInput } from '../contracts/template.ts';

export interface TransitionRecord {
  runId: number;
  from: string;
  to: string;
  reason: string;
  at: number;
}

/** SQLite-backed persistence adapter for templates, instances and transition history. */
export class Store {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  saveTemplate(t: TemplateInput, now: number): void {
    this.db.prepare(
      'INSERT INTO templates(name,image,features,cpu,memory_mb,idle_timeout_ms,created_at) VALUES(?,?,?,?,?,?,?)'
    ).run(t.name, t.image, JSON.stringify(t.features), t.cpu, t.memoryMb, t.idleTimeoutMs, now);
  }

  getTemplate(name: string): TemplateInput | null {
    const r = this.db.prepare('SELECT * FROM templates WHERE name = ?').get(name) as any;
    if (!r) return null;
    return { name: r.name, image: r.image, features: JSON.parse(r.features), cpu: r.cpu, memoryMb: r.memory_mb, idleTimeoutMs: r.idle_timeout_ms };
  }

  listTemplates(): TemplateInput[] {
    const rows = this.db.prepare('SELECT * FROM templates ORDER BY name').all() as any[];
    return rows.map((r) => ({ name: r.name, image: r.image, features: JSON.parse(r.features), cpu: r.cpu, memoryMb: r.memory_mb, idleTimeoutMs: r.idle_timeout_ms }));
  }

  createInstance(name: string, template: string, cpu: number, memoryMb: number, now: number): InstanceRow {
    const res = this.db.prepare(
      "INSERT INTO instances(name,template,state,cpu,memory_mb,run_counter,last_ready_at,created_at,updated_at) VALUES(?,?,'pending',?,?,0,NULL,?,?)"
    ).run(name, template, cpu, memoryMb, now, now);
    return this.getInstance(Number(res.lastInsertRowid))!;
  }

  getInstance(id: number): InstanceRow | null {
    return (this.db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as InstanceRow | undefined) ?? null;
  }

  getInstanceByName(name: string): InstanceRow | null {
    const rows = this.db.prepare('SELECT * FROM instances WHERE name = ? ORDER BY id DESC').all(name) as InstanceRow[];
    return rows[0] ?? null;
  }

  /** Active = any state other than deleted. */
  findActiveByName(name: string): InstanceRow | null {
    const rows = this.db.prepare("SELECT * FROM instances WHERE name = ? AND state != 'deleted' ORDER BY id DESC").all(name) as InstanceRow[];
    return rows[0] ?? null;
  }

  listInstances(filter: { template?: string; state?: InstanceState } = {}): InstanceRow[] {
    let sql = 'SELECT * FROM instances';
    const cond: string[] = [];
    const args: any[] = [];
    if (filter.template) { cond.push('template = ?'); args.push(filter.template); }
    if (filter.state) { cond.push('state = ?'); args.push(filter.state); }
    if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
    sql += ' ORDER BY id';
    return this.db.prepare(sql).all(...args) as InstanceRow[];
  }

  /** Persist a state transition: bumps run_counter, updates state, appends history. */
  applyTransition(id: number, to: InstanceState, t: TransitionRecord, lastReadyAt: number | null | undefined): InstanceRow {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE instances SET state = ?, run_counter = ?, last_ready_at = COALESCE(?, last_ready_at), updated_at = ? WHERE id = ?')
        .run(to, t.runId, lastReadyAt ?? null, t.at, id);
      this.db.prepare('INSERT INTO transitions(instance_id,run_id,from_state,to_state,reason,at) VALUES(?,?,?,?,?,?)')
        .run(id, t.runId, t.from, t.to, t.reason, t.at);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.getInstance(id)!;
  }

  history(instanceId: number): TransitionRow[] {
    return this.db.prepare('SELECT * FROM transitions WHERE instance_id = ? ORDER BY id').all(instanceId) as TransitionRow[];
  }

  recentTransitions(limit = 50): TransitionRow[] {
    return this.db.prepare('SELECT * FROM transitions ORDER BY id DESC LIMIT ?').all(limit) as TransitionRow[];
  }
}
