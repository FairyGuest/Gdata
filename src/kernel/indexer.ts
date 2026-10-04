import { eventFingerprint } from "../contract/parser.ts";
import type { NftEvent } from "../contract/types.ts";
import { applyEvents, emptyProjection, type Projection } from "./projection.ts";
import type { EventStore } from "../state/store.ts";

export interface IngestResult {
  status: "applied";
  appliedSeq: number;
  commitSeq: number;
  fingerprint: string;
  projection: Projection;
}

export class IndexerService {
  private readonly store: EventStore;

  constructor(store: EventStore) {
    this.store = store;
  }

  ingest(event: NftEvent): IngestResult {
    const fingerprint = eventFingerprint(event);
    this.store.beginImmediate();
    try {
      const projection = this.store.loadProjection();
      const expectedSeq = projection.appliedSeq + 1;
      const existing = this.store.getEvent(event.seq);

      if (existing) {
        throw {
          statusCode: 409,
          reason: "duplicate_event",
          message: `event seq ${event.seq} has already been applied`,
          detail: {
            seq: event.seq,
            fingerprintMatch: existing.fingerprint === fingerprint,
            storedFingerprint: existing.fingerprint,
            receivedFingerprint: fingerprint,
          },
        };
      }

      if (event.seq < expectedSeq) {
        throw {
          statusCode: 409,
          reason: "duplicate_event",
          message: `event seq ${event.seq} is below the next seq ${expectedSeq}`,
          detail: { seq: event.seq, expectedSeq },
        };
      }

      if (event.seq > expectedSeq) {
        throw {
          statusCode: 409,
          reason: "event_gap",
          message: `event gap: expected seq ${expectedSeq} but received ${event.seq}`,
          detail: { expectedSeq, receivedSeq: event.seq, appliedSeq: projection.appliedSeq },
        };
      }

      const nextProjection = applyEvents(projection, [event]);
      const commitSeq = this.store.allocateCommitSeq();
      this.store.insertEvent(event, commitSeq);
      this.store.replaceProjection(nextProjection);
      this.store.commit();

      return {
        status: "applied",
        appliedSeq: nextProjection.appliedSeq,
        commitSeq,
        fingerprint,
        projection: nextProjection,
      };
    } catch (err) {
      this.store.rollback();
      throw err;
    }
  }

  snapshot(): Projection {
    this.store.beginImmediate();
    try {
      const projection = this.store.loadProjection();
      this.store.commit();
      return projection;
    } catch (err) {
      this.store.rollback();
      throw err;
    }
  }

  rebuild(toSeq: number): { appliedSeq: number; projection: Projection } {
    if (!Number.isInteger(toSeq) || toSeq < 0) {
      throw {
        statusCode: 422,
        reason: "invalid_field",
        message: "toSeq must be a non-negative integer",
        detail: { got: toSeq },
      };
    }

    this.store.beginImmediate();
    try {
      const maxSeq = this.store.getMaxSeq();
      if (toSeq > maxSeq) {
        throw {
          statusCode: 422,
          reason: "invalid_field",
          message: `cannot rebuild to seq ${toSeq}; event log only reaches ${maxSeq}`,
          detail: { toSeq, maxSeq },
        };
      }

      const stored = toSeq === 0 ? [] : this.store.getEventsInRange(1, toSeq);
      if (stored.length !== toSeq) {
        throw {
          statusCode: 500,
          reason: "internal_error",
          message: "event log is not contiguous; rebuild is unsafe",
          detail: { toSeq, found: stored.length },
        };
      }
      const projection = applyEvents(emptyProjection(), stored.map((e) => e.body));
      this.store.replaceProjection(projection);
      this.store.commit();
      return { appliedSeq: projection.appliedSeq, projection };
    } catch (err) {
      this.store.rollback();
      throw err;
    }
  }
}

