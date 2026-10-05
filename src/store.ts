// SQLite state adapter (node:sqlite). Persists run reports and per-mutant
// outcomes; supports querying history by file name or mutator type.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { MutantQuery, RunReport, StoredMutantRow } from './contracts.ts';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  project_dir TEXT NOT NULL,
  source_file TEXT NOT NULL,
  score REAL NOT NULL,
  total INTEGER NOT NULL,
  killed INTEGER NOT NULL,
  survived INTEGER NOT NULL,
  timeout INTEGER NOT NULL,
  error INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  report_json TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS mutants (
  run_id TEXT NOT NULL,
  mutant_id TEXT NOT NULL,
  mutator TEXT NOT NULL,
  file TEXT NOT NULL,
  source_offset INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (run_id, mutant_id)
)`,
  'CREATE INDEX IF NOT EXISTS idx_mutants_file ON mutants(file)',
  'CREATE INDEX IF NOT EXISTS idx_mutants_mutator ON mutants(mutator)',
].join(';' + String.fromCharCode(10));

export class MutationStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  saveRun(report: RunReport): void {
    const insertRun = this.db.prepare(
      'INSERT INTO runs (run_id, status, project_dir, source_file, score, total, killed, survived, timeout, error, started_at, duration_ms, report_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertRun.run(
      report.runId, report.status, report.projectDir, report.sourceFile, report.score,
      report.total, report.killed, report.survived, report.timeout, report.error,
      report.startedAt, report.durationMs, JSON.stringify(report),
    );
    const insertMutant = this.db.prepare(
      'INSERT INTO mutants (run_id, mutant_id, mutator, file, source_offset, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const m of report.mutants) {
      insertMutant.run(report.runId, m.id, m.mutator, m.file, m.offset, m.status, m.reason);
    }
  }

  getRun(runId: string): RunReport | null {
    const row = this.db.prepare('SELECT report_json FROM runs WHERE run_id = ?').get(runId) as { report_json: string } | undefined;
    return row ? (JSON.parse(row.report_json) as RunReport) : null;
  }

  listRuns(): Array<{ runId: string; status: string; sourceFile: string; score: number; startedAt: string }> {
    const rows = this.db.prepare('SELECT run_id, status, source_file, score, started_at FROM runs ORDER BY started_at DESC').all() as unknown as Array<Record<string, string | number>>;
    return rows.map((r) => ({ runId: String(r.run_id), status: String(r.status), sourceFile: String(r.source_file), score: Number(r.score), startedAt: String(r.started_at) }));
  }

  queryMutants(query: MutantQuery): StoredMutantRow[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (query.file) { clauses.push('file = ?'); params.push(query.file); }
    if (query.mutator) { clauses.push('mutator = ?'); params.push(query.mutator); }
    if (query.runId) { clauses.push('run_id = ?'); params.push(query.runId); }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = this.db.prepare('SELECT run_id, mutant_id, mutator, file, source_offset, status, reason FROM mutants' + where + ' ORDER BY run_id, mutant_id').all(...params);
    return rows as unknown as StoredMutantRow[];
  }

  close(): void {
    this.db.close();
  }
}
