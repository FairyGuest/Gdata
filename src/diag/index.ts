import type { Ledger, DiagEventRow } from "../state/db.js";

export interface DiagEvent {
  commitSeq: number | null;
  bidId: string | null;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  detail: Record<string, unknown> | null;
}

/**
 * Diagnostic layer: every bid state transition, fill split breakdown and
 * rejection rationale is persisted with the run id and commit sequence so
 * any scenario can be replayed from the ledger alone.
 */
export class DiagLog {
  constructor(
    private readonly ledger: Ledger,
    readonly runId: string,
  ) {}

  /** Inside-transaction record (rolls back with the transaction). */
  record(event: DiagEvent): void {
    this.ledger.insertDiag({ runId: this.runId, ...event });
  }

  /** Best-effort record outside any transaction; never masks the real error. */
  recordSafe(event: DiagEvent): void {
    try {
      this.ledger.insertDiag({ runId: this.runId, ...event });
    } catch {
      // diagnostics must never break the request path
    }
  }

  list(bidId?: string): DiagEventRow[] {
    return this.ledger.listDiag(bidId);
  }
}
