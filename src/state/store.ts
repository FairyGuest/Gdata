import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ServiceError } from '../contract/errors.ts';
import type { DetectionReport, RunRecord, TrendEntry } from '../contract/types.ts';

// State adapter: persists every detection round in SQLite so flaky trends can
// be queried across rounds by test name. All storage failures are wrapped as
// COMPUTATION_FAILED with the underlying cause attached.
export class HistoryStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    try {
      if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new DatabaseSync(dbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS detection_rounds (
          round_id TEXT PRIMARY KEY,
          test_name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          total_runs INTEGER NOT NULL,
          classification TEXT NOT NULL,
          confidence REAL NOT NULL,
          passes INTEGER NOT NULL,
          failures INTEGER NOT NULL,
          first_failure_run INTEGER,
          suggested_retries INTEGER NOT NULL,
          reasoning TEXT NOT NULL,
          runs_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rounds_test ON detection_rounds(test_name, created_at);
      `);
    } catch (err) {
      throw new ServiceError('COMPUTATION_FAILED', 'failed to open history store', { cause: String(err) });
    }
  }

  saveReport(report: DetectionReport, runs: RunRecord[]): void {
    try {
      const passes = runs.filter((r) => r.outcome === 'pass').length;
      this.db.prepare(`
        INSERT INTO detection_rounds
          (round_id, test_name, created_at, total_runs, classification, confidence,
           passes, failures, first_failure_run, suggested_retries, reasoning, runs_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        report.roundId, report.testName, report.createdAt, report.totalRuns,
        report.classification, report.confidence, passes, runs.length - passes,
        report.firstFailureRun, report.suggestedRetries, report.reasoning,
        JSON.stringify(runs),
      );
    } catch (err) {
      throw new ServiceError('COMPUTATION_FAILED', `failed to persist round ${report.roundId}`, { cause: String(err) });
    }
  }

  trend(testName: string): TrendEntry[] {
    try {
      const rows = this.db.prepare(`
        SELECT round_id, created_at, classification, confidence, total_runs, passes, failures
        FROM detection_rounds WHERE test_name = ? ORDER BY created_at ASC, round_id ASC
      `).all(testName) as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        roundId: String(r.round_id),
        createdAt: String(r.created_at),
        classification: String(r.classification) as TrendEntry['classification'],
        confidence: Number(r.confidence),
        totalRuns: Number(r.total_runs),
        passes: Number(r.passes),
        failures: Number(r.failures),
      }));
    } catch (err) {
      throw new ServiceError('COMPUTATION_FAILED', `failed to query trend for '${testName}'`, { cause: String(err) });
    }
  }

  latestRound(testName: string): { report: DetectionReport; runs: RunRecord[] } | null {
    try {
      const row = this.db.prepare(`
        SELECT * FROM detection_rounds WHERE test_name = ?
        ORDER BY created_at DESC, round_id DESC LIMIT 1
      `).get(testName) as Record<string, unknown> | undefined;
      if (!row) return null;
      const passes = Number(row.passes);
      const failures = Number(row.failures);
      const classification = String(row.classification) as DetectionReport['classification'];
      return {
        report: {
          testName,
          roundId: String(row.round_id),
          totalRuns: Number(row.total_runs),
          classification,
          confidence: Number(row.confidence),
          distribution: classification === 'flaky' ? { passes, failures } : null,
          firstFailureRun: row.first_failure_run === null ? null : Number(row.first_failure_run),
          suggestedRetries: Number(row.suggested_retries),
          reasoning: String(row.reasoning),
          createdAt: String(row.created_at),
        },
        runs: JSON.parse(String(row.runs_json)) as RunRecord[],
      };
    } catch (err) {
      throw new ServiceError('COMPUTATION_FAILED', `failed to load latest round for '${testName}'`, { cause: String(err) });
    }
  }

  close(): void {
    this.db.close();
  }
}
