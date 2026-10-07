// State adapter: persists every evaluation (inputs + outputs) in SQLite so any
// run can be replayed by environment name or run id.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ServiceError, type EvaluationResult, type JsonObject, type Layers, type RunRecord } from '../contract/types.ts';

export interface RunSummary {
  runId: string;
  env: string;
  createdAt: string;
  status: 'pass' | 'drifted';
}

export class RunStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    try {
      this.db = new DatabaseSync(dbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY,
          env TEXT NOT NULL,
          created_at TEXT NOT NULL,
          input_json TEXT NOT NULL,
          output_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_runs_env ON runs(env);
      `);
    } catch (err) {
      throw new ServiceError('COMPUTATION_FAILURE', 'Failed to open SQLite store', { cause: String(err) });
    }
  }

  saveRun(env: string, input: { layers: Layers; snapshot: JsonObject }, output: EvaluationResult): RunRecord {
    const record: RunRecord = {
      runId: randomUUID(),
      env,
      createdAt: new Date().toISOString(),
      input,
      output,
    };
    try {
      this.db
        .prepare('INSERT INTO runs (run_id, env, created_at, input_json, output_json) VALUES (?, ?, ?, ?, ?)')
        .run(record.runId, record.env, record.createdAt, JSON.stringify(input), JSON.stringify(output));
    } catch (err) {
      throw new ServiceError('COMPUTATION_FAILURE', 'Failed to persist run', { cause: String(err) });
    }
    return record;
  }

  getRun(runId: string): RunRecord {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as
      | { run_id: string; env: string; created_at: string; input_json: string; output_json: string }
      | undefined;
    if (!row) {
      throw new ServiceError('NOT_FOUND', `Run "${runId}" not found`, { runId });
    }
    return {
      runId: row.run_id,
      env: row.env,
      createdAt: row.created_at,
      input: JSON.parse(row.input_json),
      output: JSON.parse(row.output_json),
    };
  }

  listRuns(env?: string): RunSummary[] {
    const rows = (env
      ? this.db.prepare('SELECT run_id, env, created_at, output_json FROM runs WHERE env = ? ORDER BY created_at').all(env)
      : this.db.prepare('SELECT run_id, env, created_at, output_json FROM runs ORDER BY created_at').all()) as Array<{
      run_id: string;
      env: string;
      created_at: string;
      output_json: string;
    }>;
    return rows.map((r) => ({
      runId: r.run_id,
      env: r.env,
      createdAt: r.created_at,
      status: (JSON.parse(r.output_json) as EvaluationResult).drift.status,
    }));
  }

  close(): void {
    this.db.close();
  }
}
