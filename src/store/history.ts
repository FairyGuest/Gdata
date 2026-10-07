import { DatabaseSync } from "node:sqlite";
import { EngineEvent } from "../core/engine.js";

/**
 * State adapter: persists every engine event (placement history) to SQLite.
 * Queryable by namespace or node for current occupancy and remaining capacity.
 */
export class HistoryStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        action TEXT NOT NULL,
        workload_id TEXT,
        namespace TEXT,
        node_id TEXT,
        cpu REAL,
        memory_mb REAL,
        detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_ns ON events(namespace);
      CREATE INDEX IF NOT EXISTS idx_events_node ON events(node_id);
    `);
  }

  record(e: EngineEvent): void {
    const d = e.detail as Record<string, unknown>;
    const req = (d.request ?? d.released ?? null) as { cpu?: number; memoryMb?: number } | null;
    this.db.prepare(`
      INSERT INTO events (run_id, seq, ts, action, workload_id, namespace, node_id, cpu, memory_mb, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      e.runId, e.seq, new Date().toISOString(), e.action,
      (d.workloadId as string) ?? null,
      (d.namespace as string) ?? null,
      (d.nodeId as string) ?? null,
      req?.cpu ?? null, req?.memoryMb ?? null,
      JSON.stringify(d),
    );
  }

  /** Placement history rows, optionally filtered by namespace or node. */
  history(filter: { namespace?: string; nodeId?: string } = {}): unknown[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (filter.namespace) { clauses.push("namespace = ?"); args.push(filter.namespace); }
    if (filter.nodeId) { clauses.push("node_id = ?"); args.push(filter.nodeId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM events ${where} ORDER BY id`).all(...args);
  }

  close(): void { this.db.close(); }
}
