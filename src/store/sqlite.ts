// State adapter: persists run history and per-mutant results in SQLite
// (node:sqlite, zero external deps). Supports queries by file or mutation type.
import { DatabaseSync } from 'node:sqlite';
import type { MutantResult, RunRecord, RunSummary, Mutant } from '../contract/types.ts';
import { ServiceError } from '../contract/errors.ts';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS runs (',
  '  run_id TEXT PRIMARY KEY,',
  '  project_dir TEXT NOT NULL,',
  '  started_at TEXT NOT NULL,',
  '  finished_at TEXT NOT NULL,',
  '  total INTEGER NOT NULL,',
  '  killed INTEGER NOT NULL,',
  '  survived INTEGER NOT NULL,',
  '  timeouts INTEGER NOT NULL,',
  '  errors INTEGER NOT NULL,',
  '  score REAL NOT NULL,',
  '  survivors_json TEXT NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS mutant_results (',
  '  run_id TEXT NOT NULL,',
  '  mutant_id TEXT NOT NULL,',
  '  file TEXT NOT NULL,',
  '  type TEXT NOT NULL,',
  '  line INTEGER NOT NULL,',
  '  original TEXT NOT NULL,',
  '  replacement TEXT NOT NULL,',
  '  status TEXT NOT NULL,',
  '  duration_ms INTEGER NOT NULL,',
  '  reason TEXT NOT NULL,',
  '  exit_code INTEGER,',
  '  output_tail TEXT NOT NULL,',
  '  PRIMARY KEY (run_id, mutant_id)',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_mutant_file ON mutant_results(file);',
  'CREATE INDEX IF NOT EXISTS idx_mutant_type ON mutant_results(type);',
].join('\n');

export class MutationStore {
  private readonly db: DatabaseSync;
  constructor(dbPath: string) {
    try {
      this.db = new DatabaseSync(dbPath);
      this.db.exec(SCHEMA);
    } catch (err) {
      throw new ServiceError('EXECUTION_FAILED', 'Failed to open SQLite store: ' + String(err), { dbPath });
    }
  }

  saveRun(record: RunRecord): void {
    const insertRun = this.db.prepare(
      'INSERT INTO runs (run_id, project_dir, started_at, finished_at, total, killed, survived, timeouts, errors, score, survivors_json)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertMutant = this.db.prepare(
      'INSERT INTO mutant_results (run_id, mutant_id, file, type, line, original, replacement, status, duration_ms, reason, exit_code, output_tail)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      insertRun.run(record.runId, record.projectDir, record.startedAt, record.finishedAt,
        record.total, record.killed, record.survived, record.timeouts, record.errors,
        record.score, JSON.stringify(record.survivors));
      for (const r of record.results) {
        insertMutant.run(record.runId, r.mutant.id, r.mutant.file, r.mutant.type, r.mutant.line,
          r.mutant.original, r.mutant.replacement, r.status, r.durationMs, r.reason,
          r.testExitCode, r.testOutputTail);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw new ServiceError('STATE_CONFLICT', 'Failed to persist run (duplicate run id?): ' + String(err));
    }
  }

  getRun(runId: string): RunRecord {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as any;
    if (!row) throw new ServiceError('NOT_FOUND', 'No run with id ' + runId);
    const results = this.db.prepare('SELECT * FROM mutant_results WHERE run_id = ? ORDER BY mutant_id')
      .all(runId) as any[];
    return {
      runId: row.run_id,
      projectDir: row.project_dir,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      total: row.total,
      killed: row.killed,
      survived: row.survived,
      timeouts: row.timeouts,
      errors: row.errors,
      score: row.score,
      survivors: JSON.parse(row.survivors_json),
      results: results.map(rowToResult),
    };
  }

  listRuns(): RunSummary[] {
    const rows = this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC').all() as any[];
    return rows.map((row) => ({
      runId: row.run_id,
      projectDir: row.project_dir,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      total: row.total, killed: row.killed, survived: row.survived,
      timeouts: row.timeouts, errors: row.errors, score: row.score,
      survivors: JSON.parse(row.survivors_json),
    }));
  }

  // Query historical mutant results filtered by file and/or mutation type.
  queryMutants(filter: { file?: string; type?: string; status?: string }): MutantResult[] {
    const clauses: string[] = [];
    const args: (string | number | null)[] = [];
    if (filter.file) { clauses.push('file = ?'); args.push(filter.file); }
    if (filter.type) { clauses.push('type = ?'); args.push(filter.type); }
    if (filter.status) { clauses.push('status = ?'); args.push(filter.status); }
    const where = clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = this.db.prepare('SELECT * FROM mutant_results' + where + ' ORDER BY run_id, mutant_id')
      .all(...args) as any[];
    return rows.map(rowToResult);
  }

  close(): void {
    this.db.close();
  }
}

function rowToResult(row: any): MutantResult {
  const mutant: Mutant = {
    id: row.mutant_id,
    file: row.file,
    offset: 0,
    line: row.line,
    column: 0,
    type: row.type,
    original: row.original,
    replacement: row.replacement,
  };
  return {
    mutant,
    status: row.status,
    durationMs: row.duration_ms,
    reason: row.reason,
    testExitCode: row.exit_code,
    testOutputTail: row.output_tail,
  };
}

