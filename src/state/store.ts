import Database from "better-sqlite3";
import { AuditEvent, AuditEventInput, GENESIS_HASH } from "../contract/types";
import {
  internalError,
  resourceExhausted,
  stateConflict,
} from "../contract/errors";
import { buildEvent } from "../core/chain";

export interface StoreOptions {
  maxEvents?: number;
}

export class AuditStore {
  private db: Database.Database;
  private readonly maxEvents: number;

  constructor(path = ":memory:", options: StoreOptions = {}) {
    this.maxEvents = options.maxEvents ?? 1_000_000;
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        seq INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        metadata TEXT,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      );
    `);
  }

  append(input: AuditEventInput): AuditEvent {
    try {
      const tx = this.db.transaction((inp: AuditEventInput): AuditEvent => {
        const tail = this.db
          .prepare("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1")
          .get() as { seq: number; hash: string } | undefined;
        const seq = tail ? tail.seq + 1 : 1;
        if (seq > this.maxEvents) {
          throw resourceExhausted("audit log capacity reached", {
            maxEvents: this.maxEvents,
          });
        }
        const prevHash = tail ? tail.hash : GENESIS_HASH;
        const event = buildEvent(seq, prevHash, inp);
        this.db
          .prepare(
            `INSERT INTO audit_events
             (seq, timestamp, actor, action, resource, metadata, prev_hash, hash)
             VALUES (@seq, @timestamp, @actor, @action, @resource, @metadata, @prevHash, @hash)`
          )
          .run({
            seq: event.seq,
            timestamp: event.timestamp,
            actor: event.actor,
            action: event.action,
            resource: event.resource,
            metadata: event.metadata ? JSON.stringify(event.metadata) : null,
            prevHash: event.prevHash,
            hash: event.hash,
          });
        return event;
      });
      return tx(input);
    } catch (err) {
      throw mapStoreError(err);
    }
  }

  list(limit = 100, offset = 0): AuditEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM audit_events ORDER BY seq ASC LIMIT ? OFFSET ?")
      .all(limit, offset) as Array<Record<string, unknown>>;
    return rows.map(rowToEvent);
  }

  all(): AuditEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM audit_events ORDER BY seq ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToEvent);
  }

  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM audit_events")
      .get() as { n: number };
    return row.n;
  }

  head(): { seq: number; hash: string } | null {
    const row = this.db
      .prepare("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1")
      .get() as { seq: number; hash: string } | undefined;
    return row ?? null;
  }

  close(): void {
    this.db.close();
  }
}

function mapStoreError(err: unknown): unknown {
  if (err instanceof Error && "code" in err) {
    const code = (err as { code?: string }).code ?? "";
    if (code.startsWith("SQLITE_CONSTRAINT")) {
      return stateConflict("database constraint violation", { code });
    }
    if (code === "SQLITE_FULL" || code === "SQLITE_IOERR") {
      return resourceExhausted("database resource exhausted", { code });
    }
    if (code.startsWith("SQLITE_")) {
      return internalError("database error", { code });
    }
  }
  return err;
}

function rowToEvent(row: Record<string, unknown>): AuditEvent {
  return {
    seq: row.seq as number,
    timestamp: row.timestamp as string,
    actor: row.actor as string,
    action: row.action as string,
    resource: row.resource as string,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    prevHash: row.prev_hash as string,
    hash: row.hash as string,
  };
}
