import Database from 'better-sqlite3';
import { DomainError } from '../contract/errors.js';
import type { TicketStatus } from '../contract/types.js';
import { migrate } from './schema.js';

export interface HistoryRow {
  from_user_id: string | null;
  to_user_id: string;
  action: 'issue' | 'transfer' | 'void' | 'check_in';
  commit_seq: number;
}

interface TicketRow {
  id: number;
  event_id: string;
  seat_id: string;
  owner_id: string;
  price_cents: number;
  status: TicketStatus;
  commit_seq: number;
  version: number;
}

export class TicketStore {
  readonly db: Database.Database;

  constructor(filename = ':memory:') {
    this.db = new Database(filename);
    this.db.pragma('busy_timeout = 1000');
    migrate(this.db);
  }

  seedFixtures(): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO events (id, name, seat_limit, price_cents) VALUES (?, ?, ?, ?)').run('evt-1', 'Synthetic Showcase', 2, 5000);
      for (const seatId of ['A-1', 'A-2']) this.db.prepare('INSERT INTO seats (event_id, id) VALUES (?, ?)').run('evt-1', seatId);
      for (const userId of ['alice', 'bob', 'carol']) this.db.prepare('INSERT INTO users (id, balance_cents) VALUES (?, ?)').run(userId, 10000);
    })();
  }

  private required<T>(row: T | undefined, reason: 'event_not_found' | 'seat_not_found' | 'user_not_found' | 'ticket_not_found', message: string): T {
    if (!row) throw new DomainError(404, reason, message);
    return row;
  }

  private event(eventId: string) {
    return this.required(this.db.prepare('SELECT id, seat_limit, price_cents FROM events WHERE id = ?').get(eventId) as { id: string; seat_limit: number; price_cents: number } | undefined, 'event_not_found', 'event not found');
  }

  private seat(eventId: string, seatId: string): void {
    this.required(this.db.prepare('SELECT 1 FROM seats WHERE event_id = ? AND id = ?').get(eventId, seatId), 'seat_not_found', 'seat not found');
  }

  private user(userId: string): void {
    this.required(this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId), 'user_not_found', 'user not found');
  }

  private parseTicketId(ticketId: string) {
    const match = /^ticket:([^:]+):([^:]+):v(\d+)$/.exec(ticketId);
    if (!match) throw new DomainError(404, 'ticket_not_found', 'ticket not found');
    return { eventId: match[1]!, seatId: match[2]!, version: Number(match[3]) };
  }

  getTicket(ticketId: string): TicketRow {
    const ref = this.parseTicketId(ticketId);
    return this.required(this.db.prepare('SELECT id, event_id, seat_id, owner_id, price_cents, status, commit_seq, version FROM tickets WHERE event_id = ? AND seat_id = ? AND version = ?').get(ref.eventId, ref.seatId, ref.version) as TicketRow | undefined, 'ticket_not_found', 'ticket not found');
  }

  private activeSeat(eventId: string, seatId: string): TicketRow | undefined {
    return this.db.prepare("SELECT t.id, t.event_id, t.seat_id, t.owner_id, t.price_cents, t.status, t.commit_seq, t.version FROM active_seats a JOIN tickets t ON t.id = a.ticket_row_id WHERE a.event_id = ? AND a.seat_id = ?").get(eventId, seatId) as TicketRow | undefined;
  }

  private activeCount(eventId: string, userId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM tickets WHERE event_id = ? AND owner_id = ? AND status != 'voided'").get(eventId, userId) as { count: number }).count;
  }

  private nextCommit(runId: number, action: 'purchase' | 'transfer' | 'refund' | 'check_in', ticketId: string): number {
    return Number(this.db.prepare('INSERT INTO commit_log (run_id, action, ticket_id) VALUES (?, ?, ?)').run(runId, action, ticketId).lastInsertRowid);
  }

  purchase(runId: number, eventId: string, seatId: string, userId: string): { ticketId: string; commitSeq: number } {
    return this.mapResourceError(() => this.db.transaction(() => {
      const event = this.event(eventId);
      this.seat(eventId, seatId);
      this.user(userId);
      if (this.activeSeat(eventId, seatId)) throw new DomainError(409, 'seat_held', 'seat already has an effective ticket');
      if (this.activeCount(eventId, userId) >= event.seat_limit) throw new DomainError(409, 'purchase_limit_reached', 'per-event purchase limit reached');
      const balance = (this.db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(userId) as { balance_cents: number }).balance_cents;
      if (balance < event.price_cents) throw new DomainError(409, 'insufficient_balance', 'insufficient balance');
      const version = (this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM tickets WHERE event_id = ? AND seat_id = ?').get(eventId, seatId) as { version: number }).version;
      const ticketId = 'ticket:' + eventId + ':' + seatId + ':v' + String(version);
      const commitSeq = this.nextCommit(runId, 'purchase', ticketId);
      this.db.prepare('UPDATE users SET balance_cents = balance_cents - ? WHERE id = ?').run(event.price_cents, userId);
      const inserted = this.db.prepare("INSERT INTO tickets (event_id, seat_id, owner_id, price_cents, status, commit_seq, version) VALUES (?, ?, ?, ?, 'sold', ?, ?)").run(eventId, seatId, userId, event.price_cents, commitSeq, version);
      this.db.prepare('INSERT INTO active_seats (event_id, seat_id, ticket_row_id) VALUES (?, ?, ?)').run(eventId, seatId, Number(inserted.lastInsertRowid));
      this.db.prepare("INSERT INTO ticket_history (ticket_id, from_user_id, to_user_id, action, commit_seq) VALUES (?, NULL, ?, 'issue', ?)").run(ticketId, userId, commitSeq);
      this.db.prepare('INSERT INTO ledger (run_id, user_id, ticket_id, amount_cents, commit_seq) VALUES (?, ?, ?, ?, ?)').run(runId, userId, ticketId, -event.price_cents, commitSeq);
      return { ticketId, commitSeq };
    })());
  }

  transfer(runId: number, ticketId: string, userId: string, toUserId: string): { commitSeq: number; status: TicketStatus } {
    return this.mapResourceError(() => this.db.transaction(() => {
      const ticket = this.getTicket(ticketId);
      this.user(toUserId);
      if (ticket.status === 'checked_in') throw new DomainError(409, 'already_checked_in', 'checked-in ticket cannot be transferred');
      if (ticket.status === 'voided') throw new DomainError(409, 'voided', 'voided ticket cannot be transferred');
      if (ticket.owner_id !== userId) throw new DomainError(409, 'not_holder', 'only current holder can transfer');
      const commitSeq = this.nextCommit(runId, 'transfer', ticketId);
      this.db.prepare('UPDATE tickets SET owner_id = ?, commit_seq = ? WHERE id = ?').run(toUserId, commitSeq, ticket.id);
      this.db.prepare("INSERT INTO ticket_history (ticket_id, from_user_id, to_user_id, action, commit_seq) VALUES (?, ?, ?, 'transfer', ?)").run(ticketId, userId, toUserId, commitSeq);
      const status: TicketStatus = 'sold';
      return { commitSeq, status };
    })());
  }

  refund(runId: number, ticketId: string, userId: string): { commitSeq: number; status: TicketStatus } {
    return this.mapResourceError(() => this.db.transaction(() => {
      const ticket = this.getTicket(ticketId);
      if (ticket.status === 'checked_in') throw new DomainError(409, 'already_checked_in', 'checked-in ticket cannot be refunded');
      if (ticket.status === 'voided') throw new DomainError(409, 'voided', 'ticket is already voided');
      if (ticket.owner_id !== userId) throw new DomainError(409, 'not_holder', 'only current holder can refund');
      const commitSeq = this.nextCommit(runId, 'refund', ticketId);
      this.db.prepare('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?').run(ticket.price_cents, userId);
      this.db.prepare("UPDATE tickets SET status = 'voided', commit_seq = ? WHERE id = ?").run(commitSeq, ticket.id);
      this.db.prepare('DELETE FROM active_seats WHERE event_id = ? AND seat_id = ?').run(ticket.event_id, ticket.seat_id);
      this.db.prepare("INSERT INTO ticket_history (ticket_id, from_user_id, to_user_id, action, commit_seq) VALUES (?, ?, ?, 'void', ?)").run(ticketId, userId, userId, commitSeq);
      this.db.prepare('INSERT INTO ledger (run_id, user_id, ticket_id, amount_cents, commit_seq) VALUES (?, ?, ?, ?, ?)').run(runId, userId, ticketId, ticket.price_cents, commitSeq);
      const status: TicketStatus = 'voided';
      return { commitSeq, status };
    })());
  }

  checkIn(runId: number, ticketId: string, userId: string): { commitSeq: number; status: TicketStatus } {
    return this.mapResourceError(() => this.db.transaction(() => {
      const ticket = this.getTicket(ticketId);
      if (ticket.status === 'checked_in') throw new DomainError(409, 'already_checked_in', 'ticket is already checked in');
      if (ticket.status === 'voided') throw new DomainError(409, 'voided', 'voided ticket cannot be checked in');
      if (ticket.owner_id !== userId) throw new DomainError(409, 'not_holder', 'only current holder can check in');
      const commitSeq = this.nextCommit(runId, 'check_in', ticketId);
      this.db.prepare("UPDATE tickets SET status = 'checked_in', commit_seq = ? WHERE id = ?").run(commitSeq, ticket.id);
      this.db.prepare("INSERT INTO ticket_history (ticket_id, from_user_id, to_user_id, action, commit_seq) VALUES (?, ?, ?, 'check_in', ?)").run(ticketId, userId, userId, commitSeq);
      const status: TicketStatus = 'checked_in';
      return { commitSeq, status };
    })());
  }

  private mapResourceError<T>(callback: () => T): T {
    try {
      return callback();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const code = (error as { code?: string }).code;
      if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') throw new DomainError(503, 'database_busy', 'database busy');
      if (code === 'SQLITE_FULL' || code === 'SQLITE_CANTOPEN') throw new DomainError(503, 'storage_exhausted', 'storage exhausted');
      throw new DomainError(500, 'compute_failed', error instanceof Error ? error.message : 'compute failure');
    }
  }

  readTicket(ticketId: string): TicketRow {
    return this.getTicket(ticketId);
  }

  readHistory(ticketId: string): HistoryRow[] {
    this.getTicket(ticketId);
    return this.db.prepare('SELECT from_user_id, to_user_id, action, commit_seq FROM ticket_history WHERE ticket_id = ? ORDER BY rowid').all(ticketId) as HistoryRow[];
  }

  balance(userId: string): number {
    this.user(userId);
    return (this.db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(userId) as { balance_cents: number }).balance_cents;
  }

  effectiveTicketCount(eventId: string, seatId: string): number {
    return this.activeSeat(eventId, seatId) === undefined ? 0 : 1;
  }
}
