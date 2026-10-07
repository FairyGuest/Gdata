// SQLite state adapter: per-target fingerprints + full build history.
// Uses the built-in node:sqlite driver (no native dependencies).

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BuildRecord, OutcomeStatus } from "../domain/types.ts";

export interface BuildStore {
  saveFingerprint(target: string, fingerprint: string): void;
  getFingerprint(target: string): string | null;
  recordBuild(rec: {
    runId: string; target: string; status: OutcomeStatus;
    reason: string | null; blockedBy: string | null;
    fingerprint: string | null; durationMs: number;
  }): void;
  latestBuild(target: string): BuildRecord | null;
  history(target: string): BuildRecord[];
  close(): void;
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS fingerprints (" +
    "target TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS builds (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, target TEXT NOT NULL," +
    "status TEXT NOT NULL, reason TEXT, blocked_by TEXT, fingerprint TEXT," +
    "duration_ms INTEGER NOT NULL, at TEXT NOT NULL)",
];

interface BuildRow {
  id: number; run_id: string; target: string; status: string;
  reason: string | null; blocked_by: string | null;
  fingerprint: string | null; duration_ms: number; at: string;
}

function toRecord(row: BuildRow): BuildRecord {
  return {
    id: row.id,
    runId: row.run_id,
    target: row.target,
    status: row.status as OutcomeStatus,
    reason: row.reason,
    blockedBy: row.blocked_by,
    fingerprint: row.fingerprint,
    durationMs: row.duration_ms,
    at: row.at,
  };
}

export class SqliteBuildStore implements BuildStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    for (const stmt of SCHEMA) this.db.exec(stmt);
  }

  saveFingerprint(target: string, fingerprint: string): void {
    this.db.prepare(
      "INSERT INTO fingerprints (target, fingerprint, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(target) DO UPDATE SET fingerprint = excluded.fingerprint, updated_at = excluded.updated_at"
    ).run(target, fingerprint, new Date().toISOString());
  }

  getFingerprint(target: string): string | null {
    const row = this.db.prepare("SELECT fingerprint FROM fingerprints WHERE target = ?").get(target) as
      | { fingerprint: string }
      | undefined;
    return row ? row.fingerprint : null;
  }

  recordBuild(rec: {
    runId: string; target: string; status: OutcomeStatus;
    reason: string | null; blockedBy: string | null;
    fingerprint: string | null; durationMs: number;
  }): void {
    this.db.prepare(
      "INSERT INTO builds (run_id, target, status, reason, blocked_by, fingerprint, duration_ms, at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(rec.runId, rec.target, rec.status, rec.reason, rec.blockedBy, rec.fingerprint, rec.durationMs, new Date().toISOString());
  }

  latestBuild(target: string): BuildRecord | null {
    const row = this.db.prepare("SELECT * FROM builds WHERE target = ? ORDER BY id DESC LIMIT 1").get(target) as
      | BuildRow
      | undefined;
    return row ? toRecord(row) : null;
  }

  history(target: string): BuildRecord[] {
    const rows = this.db.prepare("SELECT * FROM builds WHERE target = ? ORDER BY id DESC").all(target) as unknown as BuildRow[];
    return rows.map(toRecord);
  }

  close(): void {
    this.db.close();
  }
}
