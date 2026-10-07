import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogEntry } from '../kernel/logger.ts';
import type { OrchestrationDef } from '../domain/types.ts';

export interface VersionRow {
  version: number;
  definition: OrchestrationDef;
  createdAt: string;
}

export interface ComputationRow {
  runId: string;
  kind: string;
  version: number;
  result: unknown;
  createdAt: string;
}

export class OrchestratorStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS orchestrations (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
        'name TEXT NOT NULL UNIQUE,' +
        'created_at TEXT NOT NULL' +
      ');' +
      'CREATE TABLE IF NOT EXISTS versions (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
        'orchestration_id INTEGER NOT NULL REFERENCES orchestrations(id),' +
        'version INTEGER NOT NULL,' +
        'definition_json TEXT NOT NULL,' +
        'created_at TEXT NOT NULL,' +
        'UNIQUE (orchestration_id, version)' +
      ');' +
      'CREATE TABLE IF NOT EXISTS computations (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
        'orchestration_id INTEGER NOT NULL REFERENCES orchestrations(id),' +
        'version INTEGER NOT NULL,' +
        'kind TEXT NOT NULL,' +
        'run_id TEXT NOT NULL,' +
        'result_json TEXT NOT NULL,' +
        'created_at TEXT NOT NULL' +
      ');' +
      'CREATE TABLE IF NOT EXISTS run_logs (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
        'run_id TEXT NOT NULL,' +
        'seq INTEGER NOT NULL,' +
        'level TEXT NOT NULL,' +
        'event TEXT NOT NULL,' +
        'data_json TEXT NOT NULL,' +
        'created_at TEXT NOT NULL' +
      ');'
    );
  }

  close(): void {
    this.db.close();
  }

  private now(): string {
    return new Date().toISOString();
  }

  private orchestrationId(name: string): number | null {
    const row = this.db.prepare('SELECT id FROM orchestrations WHERE name = ?').get(name) as { id: number } | undefined;
    return row ? row.id : null;
  }

  hasOrchestration(name: string): boolean {
    return this.orchestrationId(name) !== null;
  }

  createOrchestration(name: string, definition: OrchestrationDef): number {
    this.db.prepare('INSERT INTO orchestrations (name, created_at) VALUES (?, ?)').run(name, this.now());
    return this.addVersion(name, definition);
  }

  addVersion(name: string, definition: OrchestrationDef): number {
    const id = this.orchestrationId(name);
    if (id === null) throw new Error('orchestration missing: ' + name);
    const latest = this.db
      .prepare('SELECT MAX(version) AS v FROM versions WHERE orchestration_id = ?')
      .get(id) as { v: number | null };
    const version = (latest.v ?? 0) + 1;
    this.db
      .prepare('INSERT INTO versions (orchestration_id, version, definition_json, created_at) VALUES (?, ?, ?, ?)')
      .run(id, version, JSON.stringify(definition), this.now());
    return version;
  }

  getDefinition(name: string, version?: number): VersionRow | null {
    const id = this.orchestrationId(name);
    if (id === null) return null;
    const row = (version === undefined
      ? this.db.prepare('SELECT version, definition_json, created_at FROM versions WHERE orchestration_id = ? ORDER BY version DESC LIMIT 1').get(id)
      : this.db.prepare('SELECT version, definition_json, created_at FROM versions WHERE orchestration_id = ? AND version = ?').get(id, version)) as
      | { version: number; definition_json: string; created_at: string }
      | undefined;
    if (!row) return null;
    return { version: row.version, definition: JSON.parse(row.definition_json) as OrchestrationDef, createdAt: row.created_at };
  }

  listVersions(name: string): number[] {
    const id = this.orchestrationId(name);
    if (id === null) return [];
    const rows = this.db.prepare('SELECT version FROM versions WHERE orchestration_id = ? ORDER BY version').all(id) as { version: number }[];
    return rows.map((r) => r.version);
  }

  saveComputation(name: string, version: number, kind: string, runId: string, result: unknown): void {
    const id = this.orchestrationId(name);
    if (id === null) throw new Error('orchestration missing: ' + name);
    this.db
      .prepare('INSERT INTO computations (orchestration_id, version, kind, run_id, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, version, kind, runId, JSON.stringify(result), this.now());
  }

  getComputation(name: string, version: number, kind: string): ComputationRow | null {
    const id = this.orchestrationId(name);
    if (id === null) return null;
    const row = this.db
      .prepare('SELECT run_id, kind, version, result_json, created_at FROM computations WHERE orchestration_id = ? AND version = ? AND kind = ? ORDER BY id DESC LIMIT 1')
      .get(id, version, kind) as { run_id: string; kind: string; version: number; result_json: string; created_at: string } | undefined;
    if (!row) return null;
    return { runId: row.run_id, kind: row.kind, version: row.version, result: JSON.parse(row.result_json), createdAt: row.created_at };
  }

  appendLog(entry: LogEntry): void {
    this.db
      .prepare('INSERT INTO run_logs (run_id, seq, level, event, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entry.runId, entry.seq, entry.level, entry.event, JSON.stringify(entry.data ?? null), this.now());
  }

  getLogs(runId: string): LogEntry[] {
    const rows = this.db
      .prepare('SELECT run_id, seq, level, event, data_json FROM run_logs WHERE run_id = ? ORDER BY seq')
      .all(runId) as { run_id: string; seq: number; level: 'info' | 'warn' | 'error'; event: string; data_json: string }[];
    return rows.map((r) => ({ runId: r.run_id, seq: r.seq, level: r.level, event: r.event, data: JSON.parse(r.data_json) }));
  }
}
