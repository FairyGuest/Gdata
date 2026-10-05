// SQLite persistence (node:sqlite). Stores run records and every request
// result so history can be queried by target URL and/or time range.

import { DatabaseSync } from "node:sqlite";
import type { RequestResult, RunConfig, RunRecord, RunSummary } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  target_url TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  config_json TEXT NOT NULL,
  summary_json TEXT,
  error_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_url ON runs(target_url);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
CREATE TABLE IF NOT EXISTS requests (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  latency_ms REAL NOT NULL,
  status_code INTEGER,
  outcome TEXT NOT NULL,
  failure_kind TEXT,
  error_message TEXT,
  PRIMARY KEY (run_id, seq)
);
`;

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createRun(runId: string, config: RunConfig, startedAt: string): void {
    this.db.prepare(
      "INSERT INTO runs (run_id, target_url, status, started_at, config_json) VALUES (?, ?, 'running', ?, ?)"
    ).run(runId, config.targetUrl, startedAt, JSON.stringify(config));
  }

  insertResults(runId: string, results: RequestResult[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO requests (run_id, seq, latency_ms, status_code, outcome, failure_kind, error_message) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    for (const r of results) {
      stmt.run(runId, r.seq, r.latencyMs, r.statusCode, r.outcome, r.failureKind, r.errorMessage);
    }
  }

  finishRun(runId: string, status: "completed" | "failed", finishedAt: string, summary: RunSummary | null, error: { code: string; message: string } | null): void {
    this.db.prepare(
      "UPDATE runs SET status = ?, finished_at = ?, summary_json = ?, error_json = ? WHERE run_id = ?"
    ).run(status, finishedAt, summary ? JSON.stringify(summary) : null, error ? JSON.stringify(error) : null, runId);
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  }

  listRuns(filter: { targetUrl?: string; from?: string; to?: string }): RunRecord[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.targetUrl) { where.push("target_url = ?"); args.push(filter.targetUrl); }
    if (filter.from) { where.push("started_at >= ?"); args.push(filter.from); }
    if (filter.to) { where.push("started_at <= ?"); args.push(filter.to); }
    const sql = "SELECT * FROM runs" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY started_at DESC";
    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  getResults(runId: string): RequestResult[] {
    const rows = this.db.prepare(
      "SELECT seq, latency_ms, status_code, outcome, failure_kind, error_message FROM requests WHERE run_id = ? ORDER BY seq"
    ).all(runId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      seq: r.seq as number,
      latencyMs: r.latency_ms as number,
      statusCode: r.status_code as number | null,
      outcome: r.outcome as RequestResult["outcome"],
      failureKind: r.failure_kind as RequestResult["failureKind"],
      errorMessage: r.error_message as string | null,
    }));
  }
}

function rowToRecord(row: Record<string, unknown>): RunRecord {
  return {
    runId: row.run_id as string,
    targetUrl: row.target_url as string,
    status: row.status as RunRecord["status"],
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
    config: JSON.parse(row.config_json as string) as RunConfig,
    summary: row.summary_json ? JSON.parse(row.summary_json as string) as RunSummary : null,
    error: row.error_json ? JSON.parse(row.error_json as string) as { code: string; message: string } : null,
  };
}
