import Database from "better-sqlite3";
import { AuditError } from "../contract/errors";
import { LogEntry } from "../contract/types";

interface Row {
  seq: number;
  timestamp: string;
  event_type: string;
  payload: string;
  prev_hash: string;
  hash: string;
}

export class SqliteAuditStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    try {
      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS audit_log (" +
          "seq INTEGER PRIMARY KEY, " +
          "timestamp TEXT NOT NULL, " +
          "event_type TEXT NOT NULL, " +
          "payload TEXT NOT NULL, " +
          "prev_hash TEXT NOT NULL, " +
          "hash TEXT NOT NULL);" +
          "CREATE TRIGGER IF NOT EXISTS audit_no_update " +
          "BEFORE UPDATE ON audit_log BEGIN " +
          "SELECT RAISE(ABORT, 'audit_log is immutable: UPDATE denied'); END;" +
          "CREATE TRIGGER IF NOT EXISTS audit_no_delete " +
          "BEFORE DELETE ON audit_log BEGIN " +
          "SELECT RAISE(ABORT, 'audit_log is immutable: DELETE denied'); END;"
      );
    } catch (err) {
      throw new AuditError(
        "STORAGE_FAILURE",
        "failed to open audit database",
        String(err)
      );
    }
  }

  private toEntry(r: Row): LogEntry {
    return {
      seq: r.seq,
      timestamp: r.timestamp,
      eventType: r.event_type,
      payload: JSON.parse(r.payload),
      prevHash: r.prev_hash,
      hash: r.hash,
    };
  }

  lastEntry(): LogEntry | null {
    const row = this.db
      .prepare("SELECT * FROM audit_log ORDER BY seq DESC LIMIT 1")
      .get() as Row | undefined;
    return row ? this.toEntry(row) : null;
  }

  count(): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS c FROM audit_log")
      .get() as { c: number };
    return r.c;
  }

  append(entry: LogEntry): void {
    try {
      this.db
        .prepare(
          "INSERT INTO audit_log (seq, timestamp, event_type, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(
          entry.seq,
          entry.timestamp,
          entry.eventType,
          JSON.stringify(entry.payload),
          entry.prevHash,
          entry.hash
        );
    } catch (err) {
      const msg = String(err);
      if (msg.includes("UNIQUE") || msg.includes("PRIMARY KEY")) {
        throw new AuditError(
          "SEQUENCE_CONFLICT",
          "sequence " + entry.seq + " already exists",
          { seq: entry.seq }
        );
      }
      throw new AuditError("STORAGE_FAILURE", "insert failed", msg);
    }
  }

  allEntries(): LogEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM audit_log ORDER BY seq ASC")
      .all() as Row[];
    return rows.map((r) => this.toEntry(r));
  }

  close(): void {
    this.db.close();
  }
}

