import Database from 'better-sqlite3';
import { FaultEventRecord, InjectionSession, InjectionStats, InjectionStatus, StartInjectionInput } from '../contracts/types';

/**
 * State adapter: owns all SQLite access. Other layers never see SQL.
 * Errors from better-sqlite3 are wrapped by callers into ChaosError categories.
 */
export class ChaosStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS injections (
        id TEXT PRIMARY KEY,
        fault_type TEXT NOT NULL,
        probability REAL NOT NULL,
        duration_ms INTEGER,
        params TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ends_at INTEGER,
        ended_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fault_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        fault_type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON fault_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(timestamp);
    `);
  }

  close(): void {
    this.db.close();
  }

  insertInjection(session: InjectionSession): void {
    this.db.prepare(`
      INSERT INTO injections (id, fault_type, probability, duration_ms, params, status, started_at, ends_at, ended_at)
      VALUES (@id, @faultType, @probability, @durationMs, @params, @status, @startedAt, @endsAt, @endedAt)
    `).run({
      id: session.id,
      faultType: session.faultType,
      probability: session.probability,
      durationMs: session.durationMs,
      params: JSON.stringify(session.params),
      status: session.status,
      startedAt: session.startedAt,
      endsAt: session.endsAt,
      endedAt: session.endedAt,
    });
  }

  updateInjectionStatus(id: string, status: InjectionStatus, endedAt: number | null): void {
    this.db.prepare('UPDATE injections SET status = ?, ended_at = ? WHERE id = ?').run(status, endedAt, id);
  }

  getInjection(id: string): InjectionSession | null {
    const row = this.db.prepare('SELECT * FROM injections WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToSession(row) : null;
  }

  listInjections(): InjectionSession[] {
    const rows = this.db.prepare('SELECT * FROM injections ORDER BY started_at DESC').all() as Record<string, unknown>[];
    return rows.map(rowToSession);
  }

  countActive(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM injections WHERE status = 'active'").get() as { n: number };
    return row.n;
  }

  findActiveByFaultType(faultType: string): InjectionSession | null {
    const row = this.db.prepare("SELECT * FROM injections WHERE status = 'active' AND fault_type = ?").get(faultType) as Record<string, unknown> | undefined;
    return row ? rowToSession(row) : null;
  }

  listActive(): InjectionSession[] {
    const rows = this.db.prepare("SELECT * FROM injections WHERE status = 'active'").all() as Record<string, unknown>[];
    return rows.map(rowToSession);
  }

  insertRequest(id: string, timestamp: number, method: string, path: string): void {
    this.db.prepare('INSERT INTO requests (id, timestamp, method, path) VALUES (?, ?, ?, ?)').run(id, timestamp, method, path);
  }

  insertFaultEvent(event: Omit<FaultEventRecord, 'id'>): void {
    this.db.prepare(`
      INSERT INTO fault_events (request_id, session_id, fault_type, timestamp, duration_ms, detail)
      VALUES (@requestId, @sessionId, @faultType, @timestamp, @durationMs, @detail)
    `).run(event);
  }

  eventsForSession(sessionId: string): FaultEventRecord[] {
    const rows = this.db.prepare('SELECT * FROM fault_events WHERE session_id = ? ORDER BY id').all(sessionId) as Record<string, unknown>[];
    return rows.map(rowToEvent);
  }

  statsForSession(sessionId: string): InjectionStats | null {
    const session = this.getInjection(sessionId);
    if (!session) return null;
    const end = session.endedAt ?? Date.now();
    const affected = this.db.prepare('SELECT COUNT(*) AS n FROM fault_events WHERE session_id = ?').get(sessionId) as { n: number };
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM requests WHERE timestamp BETWEEN ? AND ?').get(session.startedAt, end) as { n: number };
    return {
      sessionId: session.id,
      faultType: session.faultType,
      status: session.status,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      affectedRequests: affected.n,
      totalRequestsDuringSession: total.n,
    };
  }
}

function rowToSession(row: Record<string, unknown>): InjectionSession {
  return {
    id: row.id as string,
    faultType: row.fault_type as InjectionSession['faultType'],
    probability: row.probability as number,
    durationMs: (row.duration_ms as number | null) ?? null,
    params: JSON.parse(row.params as string),
    status: row.status as InjectionStatus,
    startedAt: row.started_at as number,
    endsAt: (row.ends_at as number | null) ?? null,
    endedAt: (row.ended_at as number | null) ?? null,
  };
}

function rowToEvent(row: Record<string, unknown>): FaultEventRecord {
  return {
    id: row.id as number,
    requestId: row.request_id as string,
    sessionId: row.session_id as string,
    faultType: row.fault_type as FaultEventRecord['faultType'],
    timestamp: row.timestamp as number,
    durationMs: row.duration_ms as number,
    detail: row.detail as string,
  };
}

export function inputFromSession(session: InjectionSession): StartInjectionInput {
  return {
    faultType: session.faultType,
    probability: session.probability,
    durationMs: session.durationMs,
    params: session.params,
  };
}