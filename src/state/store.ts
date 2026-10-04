import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { migrate } from "./schema.ts";
import { unavailable, internal, type AppError } from "../kernel/errors.ts";
import type { NftEvent } from "../contract/types.ts";
import { eventFingerprint } from "../contract/parser.ts";
import type { Projection, LastSale } from "../kernel/projection.ts";

export interface StoredEvent {
  seq: number;
  body: NftEvent;
  fingerprint: string;
  commitSeq: number;
}

export interface RejectionRecord {
  id: number;
  runId: string;
  reason: string;
  status: number;
  seq: number | null;
  message: string;
  detail: unknown;
  createdAt: string;
}

function mapSqliteError(err: unknown): AppError {
  const e = err as NodeJS.ErrnoException;
  const message = (e?.message ?? String(err)).toLowerCase();
  if (message.includes("database is locked")) {
    return unavailable("db_busy", "database is locked; retry the request", { cause: message });
  }
  if (
    message.includes("database or disk is full") ||
    message.includes("disk i/o error") ||
    message.includes("no space left")
  ) {
    return unavailable("db_full", "database storage exhausted", { cause: message });
  }
  return internal("sqlite failure", { cause: message });
}

export class EventStore {
  readonly db: DatabaseSync;
  private readonly stmts: ReturnType<EventStore["prepareAll"]>;

  constructor(dbPath: string) {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(dbPath);
    } catch (err) {
      throw mapSqliteError(err);
    }
    this.db = db;
    migrate(db);
    this.stmts = this.prepareAll();
  }

  static open(path: string): EventStore {
    return new EventStore(path);
  }

  private prepareAll() {
    return {
      getEvent: this.db.prepare("SELECT seq, body, fingerprint, commit_seq AS commitSeq FROM events WHERE seq = ?"),
      maxSeq: this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events"),
      rangeEvents: this.db.prepare("SELECT seq, body, fingerprint, commit_seq AS commitSeq FROM events WHERE seq >= ? AND seq <= ? ORDER BY seq ASC"),
      insertEvent: this.db.prepare("INSERT INTO events (seq, type, fingerprint, body, commit_seq) VALUES (?, ?, ?, ?, ?)"),
      nextCommit: this.db.prepare("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'next_commit_seq'"),
      readCommit: this.db.prepare("SELECT CAST(value AS INTEGER) AS v FROM meta WHERE key = 'next_commit_seq'"),
      getProj: this.db.prepare("SELECT applied_seq AS appliedSeq, volume, floor, last_sale AS lastSale FROM projection_singleton WHERE id = 1"),
      setProj: this.db.prepare("UPDATE projection_singleton SET applied_seq = ?, volume = ?, floor = ?, last_sale = ? WHERE id = 1"),
      clearOwnership: this.db.prepare("DELETE FROM ownership"),
      upsertOwner: this.db.prepare("INSERT INTO ownership (token_id, owner) VALUES (?, ?) ON CONFLICT(token_id) DO UPDATE SET owner = excluded.owner"),
      insertRejection: this.db.prepare("INSERT INTO rejections (run_id, reason, status, seq, message, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
      listRejections: this.db.prepare("SELECT id, run_id AS runId, reason, status, seq, message, detail, created_at AS createdAt FROM rejections ORDER BY id DESC LIMIT ?"),
    };
  }

  getMaxSeq(): number {
    try {
      return Number((this.stmts.maxSeq.get() as { s: number }).s);
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  getEvent(seq: number): StoredEvent | null {
    try {
      const row = this.stmts.getEvent.get(seq) as
        | { seq: number; body: string; fingerprint: string; commitSeq: number }
        | undefined;
      if (!row) return null;
      return {
        seq: row.seq,
        body: JSON.parse(row.body) as NftEvent,
        fingerprint: row.fingerprint,
        commitSeq: row.commitSeq,
      };
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  getEventsInRange(fromSeq: number, toSeq: number): StoredEvent[] {
    try {
      const rows = this.stmts.rangeEvents.all(fromSeq, toSeq) as Array<{
        seq: number; body: string; fingerprint: string; commitSeq: number;
      }>;
      return rows.map((r) => ({
        seq: r.seq,
        body: JSON.parse(r.body) as NftEvent,
        fingerprint: r.fingerprint,
        commitSeq: r.commitSeq,
      }));
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  beginImmediate(): void {
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  commit(): void {
    try {
      this.db.exec("COMMIT");
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  rollback(): void {
    try {
      this.db.exec("ROLLBACK");
    } catch {
      // rollback is best-effort
    }
  }

  allocateCommitSeq(): number {
    this.stmts.nextCommit.run();
    return Number((this.stmts.readCommit.get() as { v: number }).v);
  }

  insertEvent(event: NftEvent, commitSeq: number): void {
    try {
      this.stmts.insertEvent.run(
        event.seq,
        event.type,
        eventFingerprint(event),
        JSON.stringify(event),
        commitSeq
      );
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  loadProjection(): Projection {
    try {
      const row = this.stmts.getProj.get() as {
        appliedSeq: number; volume: number; floor: number | null; lastSale: string | null;
      };
      const owners = this.db.prepare("SELECT token_id AS tokenId, owner FROM ownership").all() as
        Array<{ tokenId: string; owner: string }>;
      const ownership: Record<string, string> = {};
      for (const o of owners) ownership[o.tokenId] = o.owner;
      return {
        appliedSeq: row.appliedSeq,
        ownership,
        volume: row.volume,
        floor: row.floor,
        lastSale: row.lastSale ? (JSON.parse(row.lastSale) as LastSale) : null,
      };
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  replaceProjection(projection: Projection): void {
    try {
      this.stmts.setProj.run(
        projection.appliedSeq,
        projection.volume,
        projection.floor,
        projection.lastSale ? JSON.stringify(projection.lastSale) : null
      );
      this.stmts.clearOwnership.run();
      const tx = this.db.prepare("SELECT 1");
      void tx;
      for (const [tokenId, owner] of Object.entries(projection.ownership)) {
        this.stmts.upsertOwner.run(tokenId, owner);
      }
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  logRejection(rec: Omit<RejectionRecord, "id" | "createdAt"> & { createdAt: string }): void {
    try {
      this.stmts.insertRejection.run(
        rec.runId,
        rec.reason,
        rec.status,
        rec.seq,
        rec.message,
        rec.detail === undefined ? null : JSON.stringify(rec.detail),
        rec.createdAt
      );
    } catch {
      // diagnostics must never break the request path
    }
  }

  listRejections(limit = 50): RejectionRecord[] {
    const rows = this.stmts.listRejections.all(limit) as Array<{
      id: number; runId: string; reason: string; status: number; seq: number | null;
      message: string; detail: string | null; createdAt: string;
    }>;
    return rows.map((r) => ({
      ...r,
      detail: r.detail ? JSON.parse(r.detail) : null,
    }));
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore close errors
    }
  }
}

export function readSqliteVersion(): string {
  try {
    return (process.versions as unknown as { sqlite?: string }).sqlite ?? "builtin";
  } catch {
    return "builtin";
  }
}

export function fileExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

