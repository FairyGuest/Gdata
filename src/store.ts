import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CaseResult, RunSummary, invalidInput } from './contracts';

/**
 * SQLite 历史存储层：保存每次运行的汇总与逐用例结果，支持按时间/文件名查询。
 */

export interface RunQuery {
  file?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export class RunStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS runs (' +
        ' run_id TEXT PRIMARY KEY,' +
        ' started_at TEXT NOT NULL,' +
        ' finished_at TEXT NOT NULL,' +
        ' duration_ms INTEGER NOT NULL,' +
        ' total INTEGER NOT NULL,' +
        ' passed INTEGER NOT NULL,' +
        ' failed INTEGER NOT NULL,' +
        ' timeout INTEGER NOT NULL,' +
        ' status TEXT NOT NULL,' +
        ' logs TEXT NOT NULL' +
        ');' +
        'CREATE TABLE IF NOT EXISTS case_results (' +
        ' id INTEGER PRIMARY KEY AUTOINCREMENT,' +
        ' run_id TEXT NOT NULL REFERENCES runs(run_id),' +
        ' file TEXT NOT NULL,' +
        ' case_name TEXT NOT NULL,' +
        ' status TEXT NOT NULL,' +
        ' failure_kind TEXT,' +
        ' error TEXT,' +
        ' duration_ms INTEGER NOT NULL,' +
        ' reason TEXT NOT NULL' +
        ');' +
        'CREATE INDEX IF NOT EXISTS idx_case_file ON case_results(file);' +
        'CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);',
    );
  }

  saveRun(summary: RunSummary): void {
    const insertRun = this.db.prepare(
      'INSERT INTO runs (run_id, started_at, finished_at, duration_ms, total, passed, failed, timeout, status, logs)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertRun.run(
      summary.runId,
      summary.startedAt,
      summary.finishedAt,
      summary.durationMs,
      summary.total,
      summary.passed,
      summary.failed,
      summary.timeout,
      summary.status,
      JSON.stringify(summary.logs),
    );
    const insertCase = this.db.prepare(
      'INSERT INTO case_results (run_id, file, case_name, status, failure_kind, error, duration_ms, reason)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of summary.results) {
      insertCase.run(
        summary.runId,
        r.file,
        r.case,
        r.status,
        r.failureKind ?? null,
        r.error ?? null,
        r.durationMs,
        r.reason,
      );
    }
  }

  getRun(runId: string): RunSummary | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    const cases = this.db
      .prepare('SELECT * FROM case_results WHERE run_id = ? ORDER BY id')
      .all(runId) as unknown as Array<Record<string, unknown>>;
    const results: CaseResult[] = cases.map((c) => ({
      file: String(c.file),
      case: String(c.case_name),
      status: c.status as CaseResult['status'],
      failureKind: (c.failure_kind ?? undefined) as CaseResult['failureKind'],
      error: (c.error ?? undefined) as string | undefined,
      durationMs: Number(c.duration_ms),
      reason: String(c.reason),
    }));
    return {
      runId: String(row.run_id),
      startedAt: String(row.started_at),
      finishedAt: String(row.finished_at),
      durationMs: Number(row.duration_ms),
      total: Number(row.total),
      passed: Number(row.passed),
      failed: Number(row.failed),
      timeout: Number(row.timeout),
      status: row.status as RunSummary['status'],
      results,
      logs: JSON.parse(String(row.logs)) as string[],
    };
  }

  queryRuns(q: RunQuery): Array<Omit<RunSummary, 'results' | 'logs'>> {
    if (q.from && Number.isNaN(Date.parse(q.from))) {
      throw invalidInput('from 不是合法时间: ' + q.from);
    }
    if (q.to && Number.isNaN(Date.parse(q.to))) {
      throw invalidInput('to 不是合法时间: ' + q.to);
    }
    const limit = q.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw invalidInput('limit 必须是 1..1000 的整数');
    }
    let sql = 'SELECT DISTINCT r.* FROM runs r';
    const conds: string[] = [];
    const params: Array<string | number> = [];
    if (q.file) {
      sql += ' JOIN case_results c ON c.run_id = r.run_id';
      conds.push('c.file LIKE ?');
      params.push('%' + q.file + '%');
    }
    if (q.from) {
      conds.push('r.started_at >= ?');
      params.push(new Date(q.from).toISOString());
    }
    if (q.to) {
      conds.push('r.started_at <= ?');
      params.push(new Date(q.to).toISOString());
    }
    if (conds.length > 0) sql += ' WHERE ' + conds.join(' AND ');
    sql += ' ORDER BY r.started_at DESC LIMIT ?';
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      runId: String(row.run_id),
      startedAt: String(row.started_at),
      finishedAt: String(row.finished_at),
      durationMs: Number(row.duration_ms),
      total: Number(row.total),
      passed: Number(row.passed),
      failed: Number(row.failed),
      timeout: Number(row.timeout),
      status: row.status as RunSummary['status'],
    }));
  }

  close(): void {
    this.db.close();
  }
}