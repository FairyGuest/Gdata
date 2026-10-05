import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonValue, SnapshotRecord } from "../contract/types.ts";
import type { SnapshotStore } from "./store.ts";
import { computeFailure } from "../diagnostics/errors.ts";

// SQLite-backed snapshot store using Node's built-in node:sqlite.
// Serialization boundary: JsonValue <-> canonical JSON text in one place.
export class SqliteSnapshotStore implements SnapshotStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    try {
      this.db = new DatabaseSync(dbPath);
    } catch (e) {
      throw computeFailure("STORE_OPEN_FAILED", "cannot open sqlite database: " + (e instanceof Error ? e.message : String(e)));
    }
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS snapshots (" +
        "name TEXT PRIMARY KEY, " +
        "data TEXT NOT NULL, " +
        "created_at TEXT NOT NULL, " +
        "updated_at TEXT NOT NULL" +
      ")"
    );
  }

  get(name: string): SnapshotRecord | null {
    let row: unknown;
    try {
      row = this.db.prepare("SELECT name, data, created_at, updated_at FROM snapshots WHERE name = ?").get(name);
    } catch (e) {
      throw computeFailure("STORE_READ_FAILED", "sqlite read failed: " + (e instanceof Error ? e.message : String(e)));
    }
    if (row === undefined) return null;
    const r = row as { name: string; data: string; created_at: string; updated_at: string };
    let data: JsonValue;
    try {
      data = JSON.parse(r.data) as JsonValue;
    } catch {
      throw computeFailure("STORE_CORRUPT", "stored snapshot '" + name + "' is not valid JSON");
    }
    return { name: r.name, data, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  put(name: string, data: JsonValue): void {
    const now = new Date().toISOString();
    let text: string;
    try {
      text = JSON.stringify(data);
    } catch (e) {
      throw computeFailure("SERIALIZE_FAILED", "cannot serialize snapshot data: " + (e instanceof Error ? e.message : String(e)));
    }
    try {
      this.db.prepare(
        "INSERT INTO snapshots (name, data, created_at, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
      ).run(name, text, now, now);
    } catch (e) {
      throw computeFailure("STORE_WRITE_FAILED", "sqlite write failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM snapshots").get() as { c: number };
    return row.c;
  }

  close(): void {
    this.db.close();
  }
}
