import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrate.ts";
import { Errors } from "../contract/errors.ts";
import type { Catalog } from "../contract/parser.ts";
import type { OwnershipEvent, TicketView } from "../contract/types.ts";

export interface SessionSeed {
  sessionId: string;
  name: string;
  limit: number;
  seats: Array<{ seatCode: string; price: number }>;
}

export interface UserSeed {
  userId: string;
  balance: number;
}

export interface Fixture {
  sessions: SessionSeed[];
  users: UserSeed[];
}

function openDb(location: string): DatabaseSync {
  const db = new DatabaseSync(location);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  return db;
}

/**
 * SQLite ledger. All state-changing operations are supplied as callbacks run
 * inside `txn()` so the kernel owns the transaction boundary.
 */
export class Ledger implements Catalog {
  readonly db: DatabaseSync;

  constructor(location = ":memory:") {
    this.db = openDb(location);
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` in a single SERIALIZABLE-ish SQLite transaction. */
  txn<T>(fn: (tx: LedgerTx) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const tx = new LedgerTx(this.db);
      const result = fn(tx);
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // best-effort rollback; surface the original error
      }
      throw err;
    }
  }

  // ----- Catalog (read-only) -----

  hasSession(sessionId: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM sessions WHERE session_id = ?").get(sessionId);
    return row !== undefined;
  }

  hasSeat(sessionId: string, seatCode: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM seats WHERE session_id = ? AND seat_code = ?")
      .get(sessionId, seatCode);
    return row !== undefined;
  }

  hasUser(userId: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM users WHERE user_id = ?").get(userId);
    return row !== undefined;
  }

  seatPrice(sessionId: string, seatCode: string): number {
    const row = this.db
      .prepare("SELECT price FROM seats WHERE session_id = ? AND seat_code = ?")
      .get(sessionId, seatCode) as { price: number } | undefined;
    if (!row) {
      throw Errors.unknownSeat(sessionId, seatCode);
    }
    return row.price;
  }

  sessionLimit(sessionId: string): number {
    const row = this.db
      .prepare("SELECT ticket_limit FROM sessions WHERE session_id = ?")
      .get(sessionId) as { ticket_limit: number } | undefined;
    if (!row) {
      throw Errors.unknownSession(sessionId);
    }
    return row.ticket_limit;
  }

  // ----- Fixture loading -----

  loadFixture(fixture: Fixture): void {
    const insSession = this.db.prepare(
      "INSERT INTO sessions(session_id, name, ticket_limit) VALUES (?, ?, ?)",
    );
    const insSeat = this.db.prepare(
      "INSERT INTO seats(session_id, seat_code, price) VALUES (?, ?, ?)",
    );
    const insUser = this.db.prepare("INSERT INTO users(user_id, balance) VALUES (?, ?)");
    this.txn((tx) => {
      for (const s of fixture.sessions) {
        insSession.run(s.sessionId, s.name, s.limit);
        for (const seat of s.seats) {
          insSeat.run(s.sessionId, seat.seatCode, seat.price);
        }
      }
      for (const u of fixture.users) {
        insUser.run(u.userId, u.balance);
      }
      void tx;
    });
  }

  // ----- Diagnostics -----

  getTicket(ticketId: string): TicketView | null {
    const row = this.db
      .prepare(
        `SELECT ticket_id, session_id, seat_code, holder_user_id, status,
                issue_seq, checkin_seq, void_seq
         FROM tickets WHERE ticket_id = ?`,
      )
      .get(ticketId) as
      | {
          ticket_id: string;
          session_id: string;
          seat_code: string;
          holder_user_id: string;
          status: TicketView["status"];
          issue_seq: number;
          checkin_seq: number | null;
          void_seq: number | null;
        }
      | undefined;
    if (!row) return null;
    return {
      ticketId: row.ticket_id,
      sessionId: row.session_id,
      seatCode: row.seat_code,
      holderUserId: row.holder_user_id,
      status: row.status,
      issueSeq: row.issue_seq,
      checkInSeq: row.checkin_seq,
      voidSeq: row.void_seq,
    };
  }

  findLiveTicket(sessionId: string, seatCode: string): TicketView | null {
    const row = this.db
      .prepare(
        `SELECT ticket_id FROM tickets
         WHERE session_id = ? AND seat_code = ? AND status <> 'voided'`,
      )
      .get(sessionId, seatCode) as { ticket_id: string } | undefined;
    return row ? this.getTicket(row.ticket_id) : null;
  }

  heldCount(userId: string, sessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM tickets
         WHERE holder_user_id = ? AND session_id = ? AND status <> 'voided'`,
      )
      .get(userId, sessionId) as { c: number };
    return row.c;
  }

  balance(userId: string): number {
    const row = this.db.prepare("SELECT balance FROM users WHERE user_id = ?").get(userId) as
      | { balance: number }
      | undefined;
    if (!row) throw Errors.unknownUser(userId);
    return row.balance;
  }

  ownershipHistory(ticketId: string): OwnershipEvent[] {
    const rows = this.db
      .prepare(
        `SELECT seq, ticket_id, action, from_user_id, to_user_id
         FROM ownership_log WHERE ticket_id = ? ORDER BY seq ASC`,
      )
      .all(ticketId) as Array<{
      seq: number;
      ticket_id: string;
      action: OwnershipEvent["action"];
      from_user_id: string | null;
      to_user_id: string | null;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      ticketId: r.ticket_id,
      action: r.action,
      fromUserId: r.from_user_id,
      toUserId: r.to_user_id,
    }));
  }

  attempts(runId: string) {
    return this.db
      .prepare(
        `SELECT req_seq, action, ok, reason, commit_seq
         FROM run_attempts WHERE run_id = ? ORDER BY req_seq ASC`,
      )
      .all(runId);
  }
}

/** Transaction-scoped helpers. All reads/writes here participate in one txn. */
export class LedgerTx {
  constructor(private readonly db: DatabaseSync) {}

  /** Explicit seat-uniqueness check (not relying on the unique index). */
  liveSeatExists(sessionId: string, seatCode: string): boolean {
    const row = this.db
      .prepare(
        `SELECT ticket_id FROM tickets
         WHERE session_id = ? AND seat_code = ? AND status <> 'voided'`,
      )
      .get(sessionId, seatCode);
    return row !== undefined;
  }

  heldCount(userId: string, sessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM tickets
         WHERE holder_user_id = ? AND session_id = ? AND status <> 'voided'`,
      )
      .get(userId, sessionId) as { c: number };
    return row.c;
  }

  balance(userId: string): number {
    const row = this.db.prepare("SELECT balance FROM users WHERE user_id = ?").get(userId) as
      | { balance: number }
      | undefined;
    if (!row) throw Errors.unknownUser(userId);
    return row.balance;
  }

  setBalance(userId: string, balance: number): void {
    if (balance < 0) {
      throw Errors.invariantViolated("negative balance", { userId, balance });
    }
    this.db.prepare("UPDATE users SET balance = ? WHERE user_id = ?").run(balance, userId);
  }

  /** Next generation number for a seat, allowing resale after refund. */
  nextSeatGeneration(sessionId: string, seatCode: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) + 1 AS g FROM tickets WHERE session_id = ? AND seat_code = ?`,
      )
      .get(sessionId, seatCode) as { g: number };
    return row.g;
  }

  insertTicket(t: {
    ticketId: string;
    sessionId: string;
    seatCode: string;
    holderUserId: string;
    issueSeq: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO tickets
           (ticket_id, session_id, seat_code, holder_user_id, status, issue_seq)
         VALUES (?, ?, ?, ?, 'held', ?)`,
      )
      .run(t.ticketId, t.sessionId, t.seatCode, t.holderUserId, t.issueSeq);
  }

  getTicketForUpdate(ticketId: string): TicketView | null {
    const row = this.db
      .prepare(
        `SELECT ticket_id, session_id, seat_code, holder_user_id, status,
                issue_seq, checkin_seq, void_seq
         FROM tickets WHERE ticket_id = ?`,
      )
      .get(ticketId) as
      | {
          ticket_id: string;
          session_id: string;
          seat_code: string;
          holder_user_id: string;
          status: TicketView["status"];
          issue_seq: number;
          checkin_seq: number | null;
          void_seq: number | null;
        }
      | undefined;
    if (!row) return null;
    return {
      ticketId: row.ticket_id,
      sessionId: row.session_id,
      seatCode: row.seat_code,
      holderUserId: row.holder_user_id,
      status: row.status,
      issueSeq: row.issue_seq,
      checkInSeq: row.checkin_seq,
      voidSeq: row.void_seq,
    };
  }

  setHolder(ticketId: string, userId: string): void {
    this.db
      .prepare("UPDATE tickets SET holder_user_id = ? WHERE ticket_id = ?")
      .run(userId, ticketId);
  }

  markCheckedIn(ticketId: string, seq: number): void {
    this.db
      .prepare("UPDATE tickets SET status = 'checked_in', checkin_seq = ? WHERE ticket_id = ?")
      .run(seq, ticketId);
  }

  markVoided(ticketId: string, seq: number): void {
    this.db
      .prepare("UPDATE tickets SET status = 'voided', void_seq = ? WHERE ticket_id = ?")
      .run(seq, ticketId);
  }

  logOwnership(e: Omit<OwnershipEvent, "seq">): number {
    const info = this.db
      .prepare(
        `INSERT INTO ownership_log(ticket_id, action, from_user_id, to_user_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(e.ticketId, e.action, e.fromUserId, e.toUserId);
    return Number(info.lastInsertRowid);
  }

  /** Append to the global commit log; returns the monotonic commit sequence. */
  appendCommit(e: {
    runId: string;
    reqSeq: number;
    action: string;
    ok: boolean;
    reason: string | null;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO commit_log(run_id, req_seq, action, ok, reason)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(e.runId, e.reqSeq, e.action, e.ok ? 1 : 0, e.reason);
    return Number(info.lastInsertRowid);
  }

  recordAttempt(e: {
    runId: string;
    reqSeq: number;
    action: string;
    ok: boolean;
    reason: string | null;
    commitSeq: number;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO run_attempts
           (run_id, req_seq, action, ok, reason, commit_seq)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(e.runId, e.reqSeq, e.action, e.ok ? 1 : 0, e.reason, e.commitSeq);
  }
}



