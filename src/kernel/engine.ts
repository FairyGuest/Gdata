// Application kernel: continuity check, transfer-legality check, transaction
// boundary and commit-order arbitration for concurrent ingest.
//
// Concurrency rule: each ingest attempt runs inside BEGIN IMMEDIATE ... COMMIT.
// SQLite serializes writers, so the transaction commit order is the single
// arbiter; there is no last-writer-wins anywhere. A duplicate seq discovered
// inside the transaction is rejected, never overwritten.

import type { DatabaseSync } from 'node:sqlite';
import type { NftEvent } from '../contract/events.ts';
import { canonicalEvent } from '../contract/events.ts';
import {
  applyToProjection,
  getAppliedSeq,
  getEventBySeq,
  getOwner,
  insertEvent,
  listEventsUpTo,
  logRejection,
  maxLoggedSeq,
  resetProjections,
  setAppliedSeq,
} from '../state/db.ts';

export type ConflictReason = 'duplicate_event' | 'event_gap' | 'invalid_transition';

export class ConflictError extends Error {
  readonly status = 409;
  readonly reason: ConflictReason;
  readonly detail: string;
  constructor(reason: ConflictReason, detail: string) {
    super(detail);
    this.name = 'ConflictError';
    this.reason = reason;
    this.detail = detail;
  }
}

export interface ApplyResult {
  appliedSeq: number;
}

export class Engine {
  private readonly db: DatabaseSync;
  private readonly runId: string;

  constructor(db: DatabaseSync, runId: string) {
    this.db = db;
    this.runId = runId;
  }

  private reject(seq: number | null, reason: ConflictReason, detail: string): never {
    // Rejection logging is best-effort and outside the ingest transaction.
    try {
      logRejection(this.db, this.runId, seq, reason, detail);
    } catch {
      // diagnostics must never mask the conflict itself
    }
    throw new ConflictError(reason, detail);
  }

  apply(ev: NftEvent): ApplyResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const appliedSeq = getAppliedSeq(this.db);

      if (ev.seq <= appliedSeq) {
        const stored = getEventBySeq(this.db, ev.seq);
        const detail =
          stored && stored.canonical === canonicalEvent(ev)
            ? 'seq ' + ev.seq + ' already applied with identical content'
            : 'seq ' + ev.seq + ' already applied with different content; refusing to overwrite';
        throw new ConflictError('duplicate_event', detail);
      }

      if (ev.seq > appliedSeq + 1) {
        throw new ConflictError(
          'event_gap',
          'seq ' + ev.seq + ' arrives while appliedSeq=' + appliedSeq + '; expected seq ' + (appliedSeq + 1),
        );
      }

      if (ev.type === 'mint') {
        const existing = getOwner(this.db, ev.tokenId);
        if (existing !== null) {
          throw new ConflictError(
            'invalid_transition',
            'mint of token ' + ev.tokenId + ' but it is already owned by ' + existing,
          );
        }
      } else {
        const owner = getOwner(this.db, ev.tokenId);
        if (owner === null) {
          throw new ConflictError('invalid_transition', ev.type + ' of unknown token ' + ev.tokenId);
        }
        if (owner !== ev.from) {
          throw new ConflictError(
            'invalid_transition',
            ev.type + ' of token ' + ev.tokenId + ' from ' + ev.from + ' but current owner is ' + owner,
          );
        }
      }

      insertEvent(this.db, ev);
      applyToProjection(this.db, ev);
      setAppliedSeq(this.db, ev.seq);
      this.db.exec('COMMIT');
      return { appliedSeq: ev.seq };
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // connection-level failure; surfaced by the original error
      }
      if (err instanceof ConflictError) {
        this.reject(ev.seq, err.reason, err.detail);
      }
      throw err;
    }
  }

  // Rebuild the projection from the immutable event log up to toSeq.
  // Uses the same applyToProjection reducer as incremental ingest.
  rebuild(toSeq: number): ApplyResult {
    if (!Number.isInteger(toSeq) || toSeq < 0) {
      throw new ConflictError('event_gap', 'rebuild target must be an integer >= 0, got: ' + toSeq);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const available = maxLoggedSeq(this.db);
      if (toSeq > available) {
        throw new ConflictError(
          'event_gap',
          'cannot rebuild to seq ' + toSeq + '; event log only reaches ' + available,
        );
      }
      const events = listEventsUpTo(this.db, toSeq);
      resetProjections(this.db);
      for (const ev of events) {
        applyToProjection(this.db, ev);
      }
      setAppliedSeq(this.db, toSeq);
      this.db.exec('COMMIT');
      return { appliedSeq: toSeq };
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      if (err instanceof ConflictError) {
        this.reject(toSeq, err.reason, err.detail);
      }
      throw err;
    }
  }
}
