// State adapter: persists placement history to SQLite (node:sqlite).
// The kernel is the source of truth for live state; this store is the
// append-only history log used for audit and per-namespace / per-node queries.
import { DatabaseSync } from 'node:sqlite';
import type { Workload } from '../contracts.ts';

export interface HistoryRow {
  seq: number;
  event: string;
  workload_id: string;
  namespace: string;
  node_id: string | null;
  cpu: number;
  mem_mb: number;
  run_id: string;
  reason: string;
  ts: string;
}

export class HistoryStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS placement_history (' +
      ' seq INTEGER PRIMARY KEY AUTOINCREMENT,' +
      ' event TEXT NOT NULL,' +
      ' workload_id TEXT NOT NULL,' +
      ' namespace TEXT NOT NULL,' +
      ' node_id TEXT,' +
      ' cpu REAL NOT NULL,' +
      ' mem_mb REAL NOT NULL,' +
      ' run_id TEXT NOT NULL,' +
      ' reason TEXT NOT NULL,' +
      " ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))" +
      ')'
    );
  }

  record(event: string, w: Workload, runId: string, reason: string): void {
    this.db.prepare(
      'INSERT INTO placement_history (event, workload_id, namespace, node_id, cpu, mem_mb, run_id, reason)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(event, w.id, w.namespace, w.nodeId, w.cpu, w.memMb, runId, reason);
  }

  history(filter: { namespace?: string; nodeId?: string } = {}): HistoryRow[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (filter.namespace !== undefined) { clauses.push('namespace = ?'); args.push(filter.namespace); }
    if (filter.nodeId !== undefined) { clauses.push('node_id = ?'); args.push(filter.nodeId); }
    const where = clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '';
    return this.db.prepare('SELECT * FROM placement_history' + where + ' ORDER BY seq').all(...args) as unknown as HistoryRow[];
  }

  close(): void { this.db.close(); }
}

