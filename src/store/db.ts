import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { CaseResult, RunSummary } from "../contract/types.ts";

/** SQLite-backed history of runs and per-case results. */
export class ResultStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        dir TEXT NOT NULL,
        pattern TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        total INTEGER NOT NULL,
        passed INTEGER NOT NULL,
        failed INTEGER NOT NULL,
        timeout INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS case_results (
        run_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        file TEXT NOT NULL,
        case_name TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        error_json TEXT,
        PRIMARY KEY (run_id, case_id)
      );
      CREATE INDEX IF NOT EXISTS idx_case_file ON case_results(file);
      CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
    `);
  }

  saveRun(summary: RunSummary): void {
    const insertRun = this.db.prepare(`
      INSERT INTO runs (run_id, dir, pattern, started_at, finished_at, duration_ms, total, passed, failed, timeout)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertCase = this.db.prepare(`
      INSERT INTO case_results (run_id, case_id, file, case_name, status, duration_ms, error_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.exec("BEGIN");
    try {
      insertRun.run(
        summary.runId, summary.dir, summary.pattern, summary.startedAt, summary.finishedAt,
        summary.durationMs, summary.total, summary.passed, summary.failed, summary.timeout,
      );
      for (const r of summary.results) {
        insertCase.run(summary.runId, r.caseId, r.file, r.caseName, r.status, r.durationMs,
          r.error ? JSON.stringify(r.error) : null);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getRun(runId: string): RunSummary | null {
    const run = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as
      | Record<string, unknown>
      | undefined;
    if (!run) return null;
    const cases = this.db
      .prepare("SELECT * FROM case_results WHERE run_id = ? ORDER BY case_id")
      .all(runId) as unknown as Array<Record<string, unknown>>;
    return {
      runId: run.run_id as string,
      dir: run.dir as string,
      pattern: run.pattern as string,
      startedAt: run.started_at as string,
      finishedAt: run.finished_at as string,
      durationMs: run.duration_ms as number,
      total: run.total as number,
      passed: run.passed as number,
      failed: run.failed as number,
      timeout: run.timeout as number,
      results: cases.map(rowToCaseResult),
    };
  }

  /** Query history, optionally filtered by file substring and ISO time range. */
  queryRuns(filter: { file?: string; from?: string; to?: string }): RunSummary[] {
    let sql = "SELECT DISTINCT r.* FROM runs r";
    const params: string[] = [];
    if (filter.file) {
      sql += " JOIN case_results c ON c.run_id = r.run_id WHERE c.file = ?";
      params.push(filter.file);
    } else {
      sql += " WHERE 1=1";
    }
    if (filter.from) { sql += " AND r.started_at >= ?"; params.push(filter.from); }
    if (filter.to) { sql += " AND r.started_at <= ?"; params.push(filter.to); }
    sql += " ORDER BY r.started_at DESC";
    const runs = this.db.prepare(sql).all(...params) as unknown as Array<Record<string, unknown>>;
    return runs.map((run) => ({
      runId: run.run_id as string,
      dir: run.dir as string,
      pattern: run.pattern as string,
      startedAt: run.started_at as string,
      finishedAt: run.finished_at as string,
      durationMs: run.duration_ms as number,
      total: run.total as number,
      passed: run.passed as number,
      failed: run.failed as number,
      timeout: run.timeout as number,
      results: (this.db
        .prepare("SELECT * FROM case_results WHERE run_id = ? ORDER BY case_id")
        .all(run.run_id as string) as unknown as Array<Record<string, unknown>>).map(rowToCaseResult),
    }));
  }

  close(): void {
    this.db.close();
  }
}

function rowToCaseResult(row: Record<string, unknown>): CaseResult {
  return {
    caseId: row.case_id as string,
    file: row.file as string,
    caseName: row.case_name as string,
    status: row.status as CaseResult["status"],
    durationMs: row.duration_ms as number,
    error: row.error_json ? (JSON.parse(row.error_json as string) as CaseResult["error"]) : undefined,
  };
}
