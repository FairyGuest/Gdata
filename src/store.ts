// Persistence: SQLite via node:sqlite. Injection history, queryable per session.
import { DatabaseSync } from 'node:sqlite';
import { ChaosError, type FaultEvent, type SessionRow } from './contracts.ts';

export class ChaosStore {
  private db: DatabaseSync;
  constructor(path: string) {
    try {
      this.db = new DatabaseSync(path);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          fault_type TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          config_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          request_id TEXT NOT NULL,
          fault_type TEXT NOT NULL,
          duration_ms REAL NOT NULL,
          detail TEXT NOT NULL,
          timestamp TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      `);
    } catch (e) {
      throw ChaosError.store(`open db ${path}: ${(e as Error).message}`);
    }
  }

  private wrap<T>(op: string, fn: () => T): T {
    try { return fn(); } catch (e) { throw ChaosError.store(`${op}: ${(e as Error).message}`); }
  }

  openSession(s: SessionRow): void {
    this.wrap('openSession', () => {
      this.db.prepare('INSERT INTO sessions (id, fault_type, started_at, ended_at, config_json) VALUES (?,?,?,?,?)')
        .run(s.id, s.fault_type, s.started_at, s.ended_at, s.config_json);
    });
  }
  closeSession(id: string, endedAt: string): void {
    this.wrap('closeSession', () => { this.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(endedAt, id); });
  }
  getSession(id: string): SessionRow | undefined {
    return this.wrap('getSession', () => this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined);
  }
  listSessions(): SessionRow[] {
    return this.wrap('listSessions', () => this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all() as unknown as SessionRow[]);
  }
  insertEvent(ev: Omit<FaultEvent, 'id'>): void {
    this.wrap('insertEvent', () => {
      this.db.prepare('INSERT INTO events (session_id, request_id, fault_type, duration_ms, detail, timestamp) VALUES (?,?,?,?,?,?)')
        .run(ev.sessionId, ev.requestId, ev.faultType, ev.durationMs, ev.detail, ev.timestamp!);
    });
  }
  countEvents(sessionId: string): number {
    return this.wrap('countEvents', () => {
      const r = this.db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT request_id) AS reqs FROM events WHERE session_id = ?').get(sessionId) as { n: number; reqs: number };
      return r.reqs;
    });
  }
  listEvents(sessionId: string): FaultEvent[] {
    return this.wrap('listEvents', () => {
      const rows = this.db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id').all(sessionId) as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: r.id as number, sessionId: r.session_id as string, requestId: r.request_id as string,
        faultType: r.fault_type as FaultEvent['faultType'], durationMs: r.duration_ms as number,
        detail: r.detail as string, timestamp: r.timestamp as string,
      }));
    });
  }
  close(): void { try { this.db.close(); } catch { /* already closed */ } }
}
