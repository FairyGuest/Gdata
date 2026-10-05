import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ComputationError } from '../errors.js';
import type { Report, ReportSummary, TestCase } from '../contract/types.js';

export interface ReportListItem {
  id: number;
  label: string | null;
  createdAt: string;
  summary: ReportSummary;
}

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS reports (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  label TEXT,',
  '  created_at TEXT NOT NULL,',
  '  summary TEXT NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS cases (',
  '  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,',
  '  case_key TEXT NOT NULL,',
  '  file TEXT NOT NULL,',
  '  name TEXT NOT NULL,',
  '  status TEXT NOT NULL,',
  '  duration_ms REAL NOT NULL,',
  '  run_id TEXT NOT NULL',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_cases_report ON cases(report_id);',
].join(' ');

/** SQLite-backed report persistence with bounded retention. */
export class ReportStore {
  private readonly db: DatabaseSync;
  private readonly maxRuns: number;

  constructor(dbPath: string, maxRuns: number) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.maxRuns = maxRuns;
    try {
      this.db = new DatabaseSync(dbPath);
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec(SCHEMA);
    } catch (cause) {
      throw new ComputationError('DB_FAILURE', 'failed to open database: ' + dbPath, { cause: String(cause) });
    }
  }

  insertReport(label: string | null, summary: ReportSummary, cases: TestCase[]): Report {
    const createdAt = new Date().toISOString();
    try {
      this.db.exec('BEGIN');
      const result = this.db
        .prepare('INSERT INTO reports (label, created_at, summary) VALUES (?, ?, ?)')
        .run(label, createdAt, JSON.stringify(summary));
      const id = Number(result.lastInsertRowid);
      const insertCase = this.db.prepare(
        'INSERT INTO cases (report_id, case_key, file, name, status, duration_ms, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const testCase of cases) {
        insertCase.run(id, testCase.key, testCase.file, testCase.name, testCase.status, testCase.durationMs, testCase.runId);
      }
      this.db.prepare('DELETE FROM reports WHERE id NOT IN (SELECT id FROM reports ORDER BY id DESC LIMIT ?)').run(this.maxRuns);
      this.db.exec('COMMIT');
      return { id, label, createdAt, summary, cases };
    } catch (cause) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw new ComputationError('DB_FAILURE', 'failed to persist report', { cause: String(cause) });
    }
  }

  getReport(id: number): Report | null {
    try {
      const row = this.db.prepare('SELECT id, label, created_at, summary FROM reports WHERE id = ?').get(id) as
        | { id: number; label: string | null; created_at: string; summary: string }
        | undefined;
      if (!row) return null;
      const caseRows = this.db
        .prepare('SELECT case_key, file, name, status, duration_ms, run_id FROM cases WHERE report_id = ? ORDER BY rowid')
        .all(id) as unknown as Array<{ case_key: string; file: string; name: string; status: TestCase['status']; duration_ms: number; run_id: string }>;
      return {
        id: row.id,
        label: row.label,
        createdAt: row.created_at,
        summary: JSON.parse(row.summary) as ReportSummary,
        cases: caseRows.map((c) => ({ key: c.case_key, file: c.file, name: c.name, status: c.status, durationMs: c.duration_ms, runId: c.run_id })),
      };
    } catch (cause) {
      throw new ComputationError('DB_FAILURE', 'failed to load report ' + id, { cause: String(cause) });
    }
  }

  listReports(): ReportListItem[] {
    try {
      const rows = this.db.prepare('SELECT id, label, created_at, summary FROM reports ORDER BY id DESC').all() as unknown as
        Array<{ id: number; label: string | null; created_at: string; summary: string }>;
      return rows.map((row) => ({ id: row.id, label: row.label, createdAt: row.created_at, summary: JSON.parse(row.summary) as ReportSummary }));
    } catch (cause) {
      throw new ComputationError('DB_FAILURE', 'failed to list reports', { cause: String(cause) });
    }
  }

  close(): void {
    this.db.close();
  }
}


