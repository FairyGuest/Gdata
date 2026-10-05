// State adapter: persists run history in SQLite (node:sqlite) and provides
// queries by target URL and/or time range for comparison.
import { DatabaseSync } from 'node:sqlite';
import type { RunResult } from './contracts.ts';

export interface RunRow {
  id: number;
  url: string;
  method: string;
  requests: number;
  concurrency: number;
  started_at: string;
  duration_ms: number;
  succeeded: number;
  failed: number;
  throughput_rps: number;
  result: string;
}

export type RunSummary = Omit<RunRow, 'result'>;

export interface RunQuery {
  url?: string;
  from?: string; // ISO timestamp, inclusive
  to?: string;   // ISO timestamp, inclusive
  limit?: number;
}

export class RunStore {
  private db: DatabaseSync;

  constructor(path = 'loadtest.db') {
    this.db = new DatabaseSync(path);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS runs (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
        'url TEXT NOT NULL,' +
        'method TEXT NOT NULL,' +
        'requests INTEGER NOT NULL,' +
        'concurrency INTEGER NOT NULL,' +
        'started_at TEXT NOT NULL,' +
        'duration_ms REAL NOT NULL,' +
        'succeeded INTEGER NOT NULL,' +
        'failed INTEGER NOT NULL,' +
        'throughput_rps REAL NOT NULL,' +
        'result TEXT NOT NULL' +
      ')',
    );
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_runs_url ON runs(url)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at)');
  }

  save(result: RunResult): number {
    const stmt = this.db.prepare(
      'INSERT INTO runs (url, method, requests, concurrency, started_at, duration_ms, succeeded, failed, throughput_rps, result)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const r = stmt.run(
      result.config.url,
      result.config.method,
      result.config.requests,
      result.config.concurrency,
      result.startedAt,
      result.durationMs,
      result.succeeded,
      result.failed,
      result.throughputRps,
      JSON.stringify(result),
    );
    return Number(r.lastInsertRowid);
  }

  query(q: RunQuery = {}): RunSummary[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.url !== undefined) { where.push('url = ?'); args.push(q.url); }
    if (q.from !== undefined) { where.push('started_at >= ?'); args.push(q.from); }
    if (q.to !== undefined) { where.push('started_at <= ?'); args.push(q.to); }
    const sql =
      'SELECT id, url, method, requests, concurrency, started_at, duration_ms, succeeded, failed, throughput_rps' +
      ' FROM runs' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY id DESC LIMIT ?';
    args.push(q.limit ?? 50);
    return this.db.prepare(sql).all(...args) as unknown as RunSummary[];
  }

  get(id: number): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as RunRow | undefined;
  }

  close(): void {
    this.db.close();
  }
}
