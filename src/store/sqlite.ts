import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RunRecord } from "../contract/types.ts";
import type { SnapshotStore, StoredSnapshot } from "../core/engine.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  key TEXT PRIMARY KEY,
  serialized TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_key ON runs(key);
`;

export class SqliteSnapshotStore implements SnapshotStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
  }

  getSnapshot(key: string): StoredSnapshot | null {
    const row = this.db
      .prepare("SELECT key, serialized, created_at, updated_at FROM snapshots WHERE key = ?")
      .get(key) as { key: string; serialized: string; created_at: string; updated_at: string } | undefined;
    if (!row) return null;
    return { key: row.key, serialized: row.serialized, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  putSnapshot(key: string, serialized: string): { created: boolean } {
    const now = new Date().toISOString();
    const existing = this.getSnapshot(key);
    if (existing) {
      this.db.prepare("UPDATE snapshots SET serialized = ?, updated_at = ? WHERE key = ?")
        .run(serialized, now, key);
      return { created: false };
    }
    this.db.prepare("INSERT INTO snapshots (key, serialized, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(key, serialized, now, now);
    return { created: true };
  }

  deleteSnapshot(key: string): boolean {
    const res = this.db.prepare("DELETE FROM snapshots WHERE key = ?").run(key);
    return Number(res.changes) > 0;
  }

  recordRun(record: RunRecord): void {
    this.db.prepare(
      "INSERT INTO runs (run_id, key, action, status, reason, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      record.runId, record.key, record.action, record.status, record.reason,
      record.detail === undefined ? null : JSON.stringify(record.detail),
      record.createdAt,
    );
  }

  listRuns(key?: string): RunRecord[] {
    const rows = (key === undefined
      ? this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC, run_id DESC LIMIT 200").all()
      : this.db.prepare("SELECT * FROM runs WHERE key = ? ORDER BY created_at DESC, run_id DESC LIMIT 200").all(key)
    ) as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToRun);
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
    return row ? rowToRun(row) : null;
  }

  close(): void {
    this.db.close();
  }
}

function rowToRun(row: Record<string, unknown>): RunRecord {
  const detailJson = row.detail_json as string | null;
  return {
    runId: row.run_id as string,
    key: row.key as string,
    action: row.action as string,
    status: row.status as string,
    reason: row.reason as string,
    detail: detailJson === null ? null : JSON.parse(detailJson),
    createdAt: row.created_at as string,
  };
}
