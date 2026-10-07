import { DatabaseSync } from 'node:sqlite';
import { OrchestrationError } from '../contract/errors.ts';

export type ResultKind = 'plan' | 'startup' | 'impact';

export interface StoredOrchestration {
  version: number;
  name: string;
  specJson: string;
  createdAt: string;
}

export interface StoredResult {
  id: number;
  orchestrationVersion: number;
  runId: string;
  kind: ResultKind;
  status: string;
  inputJson: string;
  resultJson: string;
  logJson: string;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestrations (
        version INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        orchestration_version INTEGER NOT NULL REFERENCES orchestrations(version),
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        log_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_results_version ON results(orchestration_version, kind);
      CREATE INDEX IF NOT EXISTS idx_results_run ON results(run_id);
    `);
  }

  saveOrchestration(name: string, specJson: string): number {
    const stmt = this.db.prepare(
      'INSERT INTO orchestrations (name, spec_json, created_at) VALUES (?, ?, ?)',
    );
    const res = stmt.run(name, specJson, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  getOrchestration(version: number): StoredOrchestration {
    const row = this.db
      .prepare('SELECT version, name, spec_json AS specJson, created_at AS createdAt FROM orchestrations WHERE version = ?')
      .get(version) as StoredOrchestration | undefined;
    if (!row) {
      throw new OrchestrationError('NOT_FOUND', `orchestration version ${version} does not exist`, { version });
    }
    return row;
  }

  saveResult(r: {
    orchestrationVersion: number;
    runId: string;
    kind: ResultKind;
    status: string;
    input: unknown;
    result: unknown;
    log: string[];
  }): number {
    const stmt = this.db.prepare(
      'INSERT INTO results (orchestration_version, run_id, kind, status, input_json, result_json, log_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const res = stmt.run(
      r.orchestrationVersion,
      r.runId,
      r.kind,
      r.status,
      JSON.stringify(r.input),
      JSON.stringify(r.result),
      JSON.stringify(r.log),
      new Date().toISOString(),
    );
    return Number(res.lastInsertRowid);
  }

  getLatestResult(version: number, kind: ResultKind): StoredResult {
    const row = this.db
      .prepare(
        'SELECT id, orchestration_version AS orchestrationVersion, run_id AS runId, kind, status, input_json AS inputJson, result_json AS resultJson, log_json AS logJson, created_at AS createdAt FROM results WHERE orchestration_version = ? AND kind = ? ORDER BY id DESC LIMIT 1',
      )
      .get(version, kind) as StoredResult | undefined;
    if (!row) {
      throw new OrchestrationError(
        'STATE_CONFLICT',
        `no ${kind} result stored for orchestration version ${version}`,
        { version, kind },
      );
    }
    return row;
  }

  getRun(runId: string): StoredResult {
    const row = this.db
      .prepare(
        'SELECT id, orchestration_version AS orchestrationVersion, run_id AS runId, kind, status, input_json AS inputJson, result_json AS resultJson, log_json AS logJson, created_at AS createdAt FROM results WHERE run_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(runId) as StoredResult | undefined;
    if (!row) {
      throw new OrchestrationError('NOT_FOUND', `run ${runId} does not exist`, { runId });
    }
    return row;
  }

  close(): void {
    this.db.close();
  }
}
