import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from './errors.ts';
import type { Classification } from './classifier.ts';
import type { RunLogEntry } from './executor.ts';

export interface RoundRecord {
  id: number;
  suiteId: string;
  runs: number;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface TestHistoryEntry {
  roundId: number;
  suiteId: string;
  startedAt: string;
  category: string;
  confidence: number;
  passCount: number;
  failCount: number;
  runs: number;
  firstFailureRun: number | null;
  suggestedRetries: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suite_id TEXT NOT NULL,
  runs INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS results (
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  test_name TEXT NOT NULL,
  run_index INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pass','fail')),
  reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS classifications (
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  test_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('stable-pass','stable-fail','flaky')),
  confidence REAL NOT NULL,
  pass_count INTEGER NOT NULL,
  fail_count INTEGER NOT NULL,
  runs INTEGER NOT NULL,
  first_failure_run INTEGER,
  suggested_retries INTEGER NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_results_round ON results(round_id);
CREATE INDEX IF NOT EXISTS idx_classifications_name ON classifications(test_name);
`;

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    try {
      this.db = new DatabaseSync(dbPath);
      this.db.exec(SCHEMA);
    } catch (err) {
      throw new AppError('RESOURCE_EXHAUSTED', 'failed to open or migrate database at ' + dbPath, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  close(): void {
    this.db.close();
  }

  hasActiveRound(suiteId: string): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM rounds WHERE suite_id = ? AND status = 'running'")
      .get(suiteId) as { n: number };
    return row.n > 0;
  }

  createRound(suiteId: string, runs: number): number {
    const res = this.db
      .prepare("INSERT INTO rounds (suite_id, runs, status, started_at) VALUES (?, ?, 'running', ?)")
      .run(suiteId, runs, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  completeRound(roundId: number, log: RunLogEntry[], classifications: Classification[]): void {
    try {
      this.db.exec('BEGIN');
      const insResult = this.db.prepare(
        'INSERT INTO results (round_id, test_name, run_index, outcome, reason) VALUES (?, ?, ?, ?, ?)',
      );
      for (const e of log) {
        insResult.run(roundId, e.testName, e.runIndex, e.outcome, e.reason);
      }
      const insClass = this.db.prepare(
        'INSERT INTO classifications (round_id, test_name, category, confidence, pass_count, fail_count, runs, first_failure_run, suggested_retries, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const c of classifications) {
        insClass.run(roundId, c.name, c.category, c.confidence, c.passCount, c.failCount, c.runs, c.firstFailureRun, c.suggestedRetries, c.reason);
      }
      this.db
        .prepare("UPDATE rounds SET status = 'completed', finished_at = ? WHERE id = ?")
        .run(new Date().toISOString(), roundId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw new AppError('COMPUTATION_FAILED', 'failed to persist round ' + roundId, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  failRound(roundId: number, message: string): void {
    this.db
      .prepare("UPDATE rounds SET status = 'failed', finished_at = ?, error = ? WHERE id = ?")
      .run(new Date().toISOString(), message, roundId);
  }

  getRound(roundId: number): RoundRecord | null {
    const row = this.db.prepare('SELECT * FROM rounds WHERE id = ?').get(roundId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as number,
      suiteId: row.suite_id as string,
      runs: row.runs as number,
      status: row.status as RoundRecord['status'],
      startedAt: row.started_at as string,
      finishedAt: (row.finished_at as string | null) ?? null,
      error: (row.error as string | null) ?? null,
    };
  }

  getClassifications(roundId: number): (Classification & { reason: string })[] {
    const rows = this.db
      .prepare('SELECT * FROM classifications WHERE round_id = ? ORDER BY test_name')
      .all(roundId) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      name: r.test_name as string,
      runs: r.runs as number,
      passCount: r.pass_count as number,
      failCount: r.fail_count as number,
      category: r.category as Classification['category'],
      confidence: r.confidence as number,
      firstFailureRun: (r.first_failure_run as number | null) ?? null,
      suggestedRetries: r.suggested_retries as number,
      reason: r.reason as string,
    }));
  }

  getRunLog(roundId: number): RunLogEntry[] {
    const rows = this.db
      .prepare('SELECT test_name, run_index, outcome, reason FROM results WHERE round_id = ? ORDER BY run_index, test_name')
      .all(roundId) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      testName: r.test_name as string,
      runIndex: r.run_index as number,
      outcome: r.outcome as RunLogEntry['outcome'],
      reason: r.reason as string,
    }));
  }

  getTestHistory(testName: string): TestHistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT c.round_id, r.suite_id, r.started_at, c.category, c.confidence, c.pass_count, c.fail_count, c.runs, c.first_failure_run, c.suggested_retries
         FROM classifications c JOIN rounds r ON r.id = c.round_id
         WHERE c.test_name = ? AND r.status = 'completed'
         ORDER BY c.round_id`,
      )
      .all(testName) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      roundId: r.round_id as number,
      suiteId: r.suite_id as string,
      startedAt: r.started_at as string,
      category: r.category as string,
      confidence: r.confidence as number,
      passCount: r.pass_count as number,
      failCount: r.fail_count as number,
      runs: r.runs as number,
      firstFailureRun: (r.first_failure_run as number | null) ?? null,
      suggestedRetries: r.suggested_retries as number,
    }));
  }
}
