// SQLite state adapter (node:sqlite, zero external dependencies).
// Stores the FULL lease history: terminal leases (expired/released) are kept
// and remain queryable by port or status.

import { DatabaseSync } from "node:sqlite";
import type { Lease, LeaseHistoryFilter } from "./contracts.ts";
import type { LeaseStore } from "./store.ts";
import { internalError } from "./errors.ts";

const SCHEMA =
  "CREATE TABLE IF NOT EXISTS leases (" +
  " lease_id TEXT PRIMARY KEY," +
  " target TEXT NOT NULL," +
  " port INTEGER NOT NULL," +
  " status TEXT NOT NULL CHECK (status IN ('active','expired','released'))," +
  " created_at INTEGER NOT NULL," +
  " last_heartbeat_at INTEGER NOT NULL," +
  " expires_at INTEGER NOT NULL," +
  " closed_at INTEGER" +
  "); " +
  "CREATE INDEX IF NOT EXISTS idx_leases_port ON leases(port); " +
  "CREATE INDEX IF NOT EXISTS idx_leases_status ON leases(status);";

interface Row {
  lease_id: string; target: string; port: number; status: string;
  created_at: number; last_heartbeat_at: number; expires_at: number; closed_at: number | null;
}

function toLease(r: Row): Lease {
  return {
    leaseId: r.lease_id, target: r.target, port: r.port,
    status: r.status as Lease["status"],
    createdAt: r.created_at, lastHeartbeatAt: r.last_heartbeat_at,
    expiresAt: r.expires_at, closedAt: r.closed_at,
  };
}

export class SqliteLeaseStore implements LeaseStore {
  private db: DatabaseSync;
  constructor(dbPath: string) {
    try {
      this.db = new DatabaseSync(dbPath);
      this.db.exec(SCHEMA);
    } catch (err) {
      throw internalError("failed to open sqlite database " + dbPath, String(err));
    }
  }
  private run<T>(label: string, fn: () => T): T {
    try { return fn(); } catch (err) {
      throw internalError("sqlite operation failed: " + label, String(err));
    }
  }
  insert(lease: Lease): void {
    this.run("insert", () => {
      this.db.prepare(
        "INSERT INTO leases (lease_id,target,port,status,created_at,last_heartbeat_at,expires_at,closed_at) VALUES (?,?,?,?,?,?,?,?)"
      ).run(lease.leaseId, lease.target, lease.port, lease.status,
        lease.createdAt, lease.lastHeartbeatAt, lease.expiresAt, lease.closedAt);
    });
  }
  update(lease: Lease): void {
    this.run("update", () => {
      this.db.prepare(
        "UPDATE leases SET target=?, port=?, status=?, created_at=?, last_heartbeat_at=?, expires_at=?, closed_at=? WHERE lease_id=?"
      ).run(lease.target, lease.port, lease.status,
        lease.createdAt, lease.lastHeartbeatAt, lease.expiresAt, lease.closedAt, lease.leaseId);
    });
  }
  getById(leaseId: string): Lease | null {
    return this.run("getById", () => {
      const row = this.db.prepare("SELECT * FROM leases WHERE lease_id = ?").get(leaseId) as Row | undefined;
      return row ? toLease(row) : null;
    });
  }
  activeByPort(port: number): Lease | null {
    return this.run("activeByPort", () => {
      const row = this.db.prepare("SELECT * FROM leases WHERE port = ? AND status = 'active'").get(port) as Row | undefined;
      return row ? toLease(row) : null;
    });
  }
  listActive(): Lease[] {
    return this.run("listActive", () =>
      (this.db.prepare("SELECT * FROM leases WHERE status = 'active' ORDER BY port").all() as unknown as Row[]).map(toLease));
  }
  query(filter: LeaseHistoryFilter): Lease[] {
    return this.run("query", () => {
      const where: string[] = [];
      const args: (number | string)[] = [];
      if (filter.port !== undefined) { where.push("port = ?"); args.push(filter.port); }
      if (filter.status !== undefined) { where.push("status = ?"); args.push(filter.status); }
      const sql = "SELECT * FROM leases" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY created_at, lease_id";
      return (this.db.prepare(sql).all(...args) as unknown as Row[]).map(toLease);
    });
  }
  all(): Lease[] { return this.query({}); }
  close(): void { this.db.close(); }
}

