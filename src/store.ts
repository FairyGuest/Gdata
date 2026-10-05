/**
 * State adapter: persists datasets in SQLite (node:sqlite) so a dataset
 * can later be regenerated from its seed and compared for consistency.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { NotFoundError, StateConflictError } from "./errors.ts";
import type { DatasetSchema } from "./schema.ts";

export interface StoredDataset {
  id: string;
  seed: number;
  count: number;
  schema: DatasetSchema;
  rows: Record<string, unknown>[];
  createdAt: string;
}

export class DatasetStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS datasets (
        id TEXT PRIMARY KEY,
        seed INTEGER NOT NULL,
        count INTEGER NOT NULL,
        schema TEXT NOT NULL,
        rows TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }

  save(id: string, seed: number, schema: DatasetSchema, rows: Record<string, unknown>[]): StoredDataset {
    const existing = this.db.prepare("SELECT id FROM datasets WHERE id = ?").get(id);
    if (existing) {
      throw new StateConflictError(`dataset "${id}" already exists`, { id });
    }
    const createdAt = new Date().toISOString();
    this.db.prepare(
      "INSERT INTO datasets (id, seed, count, schema, rows, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, seed, rows.length, JSON.stringify(schema), JSON.stringify(rows), createdAt);
    return { id, seed, count: rows.length, schema, rows, createdAt };
  }

  get(id: string): StoredDataset {
    const row = this.db.prepare("SELECT * FROM datasets WHERE id = ?").get(id) as
      | { id: string; seed: number; count: number; schema: string; rows: string; created_at: string }
      | undefined;
    if (!row) throw new NotFoundError(`dataset "${id}" not found`, { id });
    return {
      id: row.id,
      seed: row.seed,
      count: row.count,
      schema: JSON.parse(row.schema) as DatasetSchema,
      rows: JSON.parse(row.rows) as Record<string, unknown>[],
      createdAt: row.created_at,
    };
  }

  list(): Array<{ id: string; seed: number; count: number; createdAt: string }> {
    const rows = this.db.prepare("SELECT id, seed, count, created_at FROM datasets ORDER BY created_at").all() as
      Array<{ id: string; seed: number; count: number; created_at: string }>;
    return rows.map((r) => ({ id: r.id, seed: r.seed, count: r.count, createdAt: r.created_at }));
  }

  close(): void {
    this.db.close();
  }
}
