// State adapter: SQLite (node:sqlite) persistence for the vulnerability
// database, scan runs (with idempotency keys) and per-run diagnostic logs.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ScanError } from '../contract/errors.ts';
import type { VulnEntry } from '../core/matcher.ts';

export interface RunRow {
  run_id: string;
  idempotency_key: string | null;
  request_fingerprint: string;
  status: string;
  report_json: string;
  created_at: string;
}

export interface LogRow {
  seq: number;
  run_id: string;
  step: string;
  detail: string;
  ts: string;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vulnerabilities (
        id TEXT PRIMARY KEY,
        package TEXT NOT NULL,
        range TEXT NOT NULL,
        severity TEXT NOT NULL,
        summary TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        request_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_logs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        step TEXT NOT NULL,
        detail TEXT NOT NULL,
        ts TEXT NOT NULL
      );
    `);
  }

  loadVulnDb(jsonPath: string): number {
    let entries: VulnEntry[];
    try {
      entries = JSON.parse(readFileSync(jsonPath, 'utf8')) as VulnEntry[];
    } catch (err) {
      throw new ScanError('COMPUTATION_FAILURE',
        'Failed to load vulnerability database from ' + jsonPath + ': ' + (err as Error).message);
    }
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO vulnerabilities (id, package, range, severity, summary) VALUES (?, ?, ?, ?, ?)');
    for (const v of entries) insert.run(v.id, v.package, v.range, v.severity, v.summary);
    return entries.length;
  }

  listVulns(): VulnEntry[] {
    return this.db.prepare('SELECT id, package, range, severity, summary FROM vulnerabilities')
      .all() as unknown as VulnEntry[];
  }

  saveRun(runId: string, idempotencyKey: string | null, fingerprint: string, status: string, report: unknown): void {
    this.db.prepare(
      'INSERT INTO runs (run_id, idempotency_key, request_fingerprint, status, report_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, idempotencyKey, fingerprint, status, JSON.stringify(report), new Date().toISOString());
  }

  findByIdempotencyKey(key: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE idempotency_key = ?').get(key) as RunRow | undefined;
  }

  getRun(runId: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as RunRow | undefined;
  }

  appendLog(runId: string, step: string, detail: string): void {
    this.db.prepare('INSERT INTO run_logs (run_id, step, detail, ts) VALUES (?, ?, ?, ?)')
      .run(runId, step, detail, new Date().toISOString());
  }

  getLogs(runId: string): LogRow[] {
    return this.db.prepare('SELECT * FROM run_logs WHERE run_id = ? ORDER BY seq').all(runId) as unknown as LogRow[];
  }

  close(): void {
    this.db.close();
  }
}
