// State adapter: persists every merge+drift run (inputs and outputs) in
// SQLite so any run can be replayed by environment name.

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { AppError } from "../contracts/errors.ts";
import type { DriftInput, DriftOutput, RunRecord } from "../contracts/types.ts";

export interface RunSummary {
  runId: string;
  env: string;
  createdAt: string;
  status: string;
}

export class RunStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id     TEXT PRIMARY KEY,
        env        TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status     TEXT NOT NULL,
        input_json  TEXT NOT NULL,
        output_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_env ON runs(env, created_at);
    `);
  }

  saveRun(input: DriftInput, output: DriftOutput): RunRecord {
    const record: RunRecord = {
      runId: output.runId,
      env: input.env,
      createdAt: new Date().toISOString(),
      input,
      merge: output.merge,
      report: output.report,
    };
    try {
      this.db
        .prepare("INSERT INTO runs (run_id, env, created_at, status, input_json, output_json) VALUES (?, ?, ?, ?, ?, ?)")
        .run(record.runId, record.env, record.createdAt, record.report.status, JSON.stringify(record.input), JSON.stringify({ merge: record.merge, report: record.report }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE constraint")) {
        throw new AppError("STATE_CONFLICT", `run id "${record.runId}" already persisted`, { runId: record.runId });
      }
      throw new AppError("COMPUTATION_FAILURE", `failed to persist run: ${message}`);
    }
    return record;
  }

  getRun(runId: string): RunRecord {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as Record<string, string> | undefined;
    if (!row) throw new AppError("NOT_FOUND", `run "${runId}" not found`, { runId });
    return rowToRecord(row);
  }

  listRuns(env?: string): RunSummary[] {
    const rows = (env === undefined
      ? this.db.prepare("SELECT run_id, env, created_at, status FROM runs ORDER BY created_at ASC, run_id ASC").all()
      : this.db.prepare("SELECT run_id, env, created_at, status FROM runs WHERE env = ? ORDER BY created_at ASC, run_id ASC").all(env)) as unknown as Record<string, string>[];
    return rows.map((r) => ({ runId: r["run_id"]!, env: r["env"]!, createdAt: r["created_at"]!, status: r["status"]! }));
  }

  close(): void {
    this.db.close();
  }
}

function rowToRecord(row: Record<string, string>): RunRecord {
  const output = JSON.parse(row["output_json"]!) as { merge: RunRecord["merge"]; report: RunRecord["report"] };
  return {
    runId: row["run_id"]!,
    env: row["env"]!,
    createdAt: row["created_at"]!,
    input: JSON.parse(row["input_json"]!) as DriftInput,
    merge: output.merge,
    report: output.report,
  };
}

export function newRunId(): string {
  return randomUUID();
}
