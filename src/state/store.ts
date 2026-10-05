import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { FactoryError } from '../contract/errors.ts';
import { parseSchema, type DatasetSchema, type Limits } from '../contract/schema.ts';
import { generateDataset } from '../kernel/generate.ts';
import type { RunLog } from '../diagnostics/runlog.ts';

export interface DatasetRecord {
  name: string;
  seed: number | string;
  count: number;
  schema: unknown;
  rows: Record<string, unknown>[];
  createdAt: string;
}

export class DatasetStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS datasets (' +
        'name TEXT PRIMARY KEY, seed TEXT NOT NULL, count INTEGER NOT NULL, ' +
        'schema TEXT NOT NULL, rows TEXT NOT NULL, created_at TEXT NOT NULL)',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS runs (' +
        'run_id TEXT PRIMARY KEY, seed TEXT NOT NULL, outcome TEXT NOT NULL, ' +
        'failure_category TEXT, log TEXT NOT NULL, created_at TEXT NOT NULL)',
    );
  }

  saveDataset(name: string, schema: DatasetSchema, seed: number | string, count: number, limits: Limits): DatasetRecord {
    const existing = this.db.prepare('SELECT name FROM datasets WHERE name = ?').get(name);
    if (existing) {
      throw new FactoryError('STATE_CONFLICT', 'dataset "' + name + '" already exists', { name });
    }
    const result = generateDataset(schema, seed, count, limits);
    this.recordRun(result.log);
    const createdAt = new Date().toISOString();
    this.db
      .prepare('INSERT INTO datasets (name, seed, count, schema, rows, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, JSON.stringify(seed), count, JSON.stringify(schema), JSON.stringify(result.rows), createdAt);
    return { name, seed, count, schema, rows: result.rows, createdAt };
  }

  getDataset(name: string): DatasetRecord {
    const row = this.db.prepare('SELECT * FROM datasets WHERE name = ?').get(name) as
      | { name: string; seed: string; count: number; schema: string; rows: string; created_at: string }
      | undefined;
    if (!row) {
      throw new FactoryError('STATE_CONFLICT', 'dataset "' + name + '" not found', { name });
    }
    return {
      name: row.name,
      seed: JSON.parse(row.seed) as number | string,
      count: row.count,
      schema: JSON.parse(row.schema),
      rows: JSON.parse(row.rows),
      createdAt: row.created_at,
    };
  }

  listDatasets(): { name: string; seed: number | string; count: number; createdAt: string }[] {
    const rows = this.db.prepare('SELECT name, seed, count, created_at FROM datasets ORDER BY name').all() as unknown as {
      name: string; seed: string; count: number; created_at: string;
    }[];
    return rows.map((r) => ({ name: r.name, seed: JSON.parse(r.seed) as number | string, count: r.count, createdAt: r.created_at }));
  }

  verifyDataset(name: string, limits: Limits): { name: string; consistent: boolean; regenerated: number; reason: string } {
    const record = this.getDataset(name);
    const schema = parseSchema(record.schema, limits);
    const result = generateDataset(schema, record.seed, record.count, limits);
    this.recordRun(result.log);
    const consistent = JSON.stringify(result.rows) === JSON.stringify(record.rows);
    return {
      name,
      consistent,
      regenerated: result.rows.length,
      reason: consistent
        ? 'regenerated rows from stored seed are byte-identical to persisted rows'
        : 'regenerated rows differ from persisted rows',
    };
  }

  recordRun(log: RunLog): void {
    this.db
      .prepare('INSERT INTO runs (run_id, seed, outcome, failure_category, log, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        log.runId,
        JSON.stringify(log.seed),
        log.outcome ?? 'unknown',
        log.failureCategory ?? null,
        JSON.stringify(log),
        new Date().toISOString(),
      );
  }

  getRun(runId: string): RunLog {
    const row = this.db.prepare('SELECT log FROM runs WHERE run_id = ?').get(runId) as { log: string } | undefined;
    if (!row) {
      throw new FactoryError('STATE_CONFLICT', 'run "' + runId + '" not found', { runId });
    }
    return JSON.parse(row.log);
  }

  close(): void {
    this.db.close();
  }
}
