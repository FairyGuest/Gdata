// State adapter: SQLite-backed lease store (node:sqlite, a local built-in
// dependency, no external service). Persists the FULL lease history; rows are
// never deleted, only transitioned between statuses.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LeaseRecord, LeaseStatus } from "./contract.ts";

export interface LeaseFilter {
  port?: number;
  status?: LeaseStatus;
}

export interface LeaseStore {
  insert(lease: LeaseRecord): void;
  update(lease: LeaseRecord): void;
  getById(id: string): LeaseRecord | null;
  getActiveByPort(port: number): LeaseRecord | null;
  listActive(): LeaseRecord[];
  list(filter: LeaseFilter): LeaseRecord[];
  countByStatus(): Record<LeaseStatus, number>;
  close(): void;
}

interface Row {
  id: string;
  target: string;
  port: number;
  status: string;
  created_at: number;
  last_heartbeat_at: number;
  expires_at: number;
  closed_at: number | null;
  close_reason: string | null;
}

function toRecord(r: Row): LeaseRecord {
  return {
    id: r.id,
    target: r.target,
    port: r.port,
    status: r.status as LeaseStatus,
    createdAt: r.created_at,
    lastHeartbeatAt: r.last_heartbeat_at,
    expiresAt: r.expires_at,
    closedAt: r.closed_at,
    closeReason: r.close_reason as LeaseRecord["closeReason"],
  };
}

export class SqliteLeaseStore implements LeaseStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS leases (" +
        " id TEXT PRIMARY KEY," +
        " target TEXT NOT NULL," +
        " port INTEGER NOT NULL," +
        " status TEXT NOT NULL CHECK (status IN ('active','expired','released'))," +
        " created_at INTEGER NOT NULL," +
        " last_heartbeat_at INTEGER NOT NULL," +
        " expires_at INTEGER NOT NULL," +
        " closed_at INTEGER," +
        " close_reason TEXT" +
        ")"
    );
    // At most one ACTIVE lease per port, enforced at the storage layer too.
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_leases_active_port ON leases(port) WHERE status = 'active'"
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_leases_status ON leases(status)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_leases_port ON leases(port)");
  }

  insert(lease: LeaseRecord): void {
    this.db
      .prepare(
        "INSERT INTO leases (id, target, port, status, created_at, last_heartbeat_at, expires_at, closed_at, close_reason)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        lease.id, lease.target, lease.port, lease.status,
        lease.createdAt, lease.lastHeartbeatAt, lease.expiresAt,
        lease.closedAt, lease.closeReason
      );
  }

  update(lease: LeaseRecord): void {
    this.db
      .prepare(
        "UPDATE leases SET status = ?, last_heartbeat_at = ?, expires_at = ?, closed_at = ?, close_reason = ? WHERE id = ?"
      )
      .run(lease.status, lease.lastHeartbeatAt, lease.expiresAt, lease.closedAt, lease.closeReason, lease.id);
  }

  getById(id: string): LeaseRecord | null {
    const row = this.db.prepare("SELECT * FROM leases WHERE id = ?").get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  getActiveByPort(port: number): LeaseRecord | null {
    const row = this.db.prepare("SELECT * FROM leases WHERE port = ? AND status = 'active'").get(port) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  listActive(): LeaseRecord[] {
    const rows = this.db.prepare("SELECT * FROM leases WHERE status = 'active' ORDER BY port ASC").all() as Row[];
    return rows.map(toRecord);
  }

  list(filter: LeaseFilter): LeaseRecord[] {
    let sql = "SELECT * FROM leases";
    const cond: string[] = [];
    const params: unknown[] = [];
    if (filter.port !== undefined) { cond.push("port = ?"); params.push(filter.port); }
    if (filter.status !== undefined) { cond.push("status = ?"); params.push(filter.status); }
    if (cond.length > 0) sql += " WHERE " + cond.join(" AND ");
    sql += " ORDER BY port ASC, created_at ASC";
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map(toRecord);
  }

  countByStatus(): Record<LeaseStatus, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM leases GROUP BY status").all() as { status: string; n: number }[];
    const out: Record<LeaseStatus, number> = { active: 0, expired: 0, released: 0 };
    for (const r of rows) out[r.status as LeaseStatus] = Number(r.n);
    return out;
  }

  close(): void {
    this.db.close();
  }
}
