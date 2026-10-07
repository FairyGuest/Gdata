/** State adapter: persists targets, fingerprints, runs and build history in SQLite. */

import { DatabaseSync } from 'node:sqlite';
import type { BuildRecord, RunResult, TargetDefinition } from '../domain/types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS targets (
  name TEXT PRIMARY KEY,
  paths TEXT NOT NULL,
  deps TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fingerprints (
  target TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_id INTEGER PRIMARY KEY,
  changed_paths TEXT NOT NULL,
  affected TEXT NOT NULL,
  build_order TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  target TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  fingerprint TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_builds_target ON builds(target, id);
`;

export class SqliteStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  replaceTargets(defs: TargetDefinition[]): void {
    this.db.exec('DELETE FROM targets');
    const stmt = this.db.prepare('INSERT INTO targets (name, paths, deps) VALUES (?, ?, ?)');
    for (const d of defs) stmt.run(d.name, JSON.stringify(d.paths), JSON.stringify(d.deps));
  }

  getTargets(): TargetDefinition[] {
    const rows = this.db.prepare('SELECT name, paths, deps FROM targets ORDER BY name').all() as unknown as Array<{ name: string; paths: string; deps: string }>;
    return rows.map((r) => ({ name: r.name, paths: JSON.parse(r.paths), deps: JSON.parse(r.deps) }));
  }

  getFingerprint(target: string): string | null {
    const row = this.db.prepare('SELECT fingerprint FROM fingerprints WHERE target = ?').get(target) as { fingerprint: string } | undefined;
    return row?.fingerprint ?? null;
  }

  setFingerprint(target: string, fingerprint: string): void {
    this.db.prepare(
      'INSERT INTO fingerprints (target, fingerprint, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(target) DO UPDATE SET fingerprint = excluded.fingerprint, updated_at = excluded.updated_at',
    ).run(target, fingerprint, new Date().toISOString());
  }

  nextRunId(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(run_id), 0) + 1 AS next FROM runs').get() as { next: number };
    return row.next;
  }

  createRun(runId: number, changedPaths: string[], affected: string[], order: string[]): void {
    this.db.prepare('INSERT INTO runs (run_id, changed_paths, affected, build_order, status) VALUES (?, ?, ?, ?, ?)')
      .run(runId, JSON.stringify(changedPaths), JSON.stringify(affected), JSON.stringify(order), 'running');
  }

  finishRun(runId: number): void {
    this.db.prepare("UPDATE runs SET status = 'completed' WHERE run_id = ?").run(runId);
  }

  insertBuild(rec: BuildRecord): void {
    this.db.prepare(
      'INSERT INTO builds (run_id, target, outcome, reason, fingerprint, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(rec.runId, rec.target, rec.outcome, rec.reason, rec.fingerprint, rec.startedAt, rec.finishedAt);
  }

  private toRecord(row: unknown): BuildRecord {
    const r = row as { run_id: number; target: string; outcome: string; reason: string | null; fingerprint: string | null; started_at: string; finished_at: string };
    return {
      runId: r.run_id, target: r.target, outcome: r.outcome as BuildRecord['outcome'],
      reason: r.reason, fingerprint: r.fingerprint, startedAt: r.started_at, finishedAt: r.finished_at,
    };
  }

  getRunRecords(runId: number): BuildRecord[] {
    const rows = this.db.prepare('SELECT * FROM builds WHERE run_id = ? ORDER BY id').all(runId);
    return rows.map((r) => this.toRecord(r));
  }

  getRun(runId: number): RunResult | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as
      { run_id: number; changed_paths: string; affected: string; build_order: string; status: string } | undefined;
    if (!row) return null;
    return {
      runId: row.run_id,
      changedPaths: JSON.parse(row.changed_paths),
      affected: JSON.parse(row.affected),
      order: JSON.parse(row.build_order),
      records: this.getRunRecords(runId),
      status: row.status as RunResult['status'],
    };
  }

  getLastBuild(target: string): BuildRecord | null {
    const row = this.db.prepare('SELECT * FROM builds WHERE target = ? ORDER BY id DESC LIMIT 1').get(target);
    return row ? this.toRecord(row) : null;
  }

  getSkips(target: string): BuildRecord[] {
    const rows = this.db.prepare("SELECT * FROM builds WHERE target = ? AND outcome = 'skipped' ORDER BY id").all(target);
    return rows.map((r) => this.toRecord(r));
  }

  getHistory(target: string): BuildRecord[] {
    const rows = this.db.prepare('SELECT * FROM builds WHERE target = ? ORDER BY id').all(target);
    return rows.map((r) => this.toRecord(r));
  }
}