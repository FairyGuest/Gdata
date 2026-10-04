import type { Ledger, OrderEventRecord } from '../state/ledger.ts';

export interface JournalEventInput {
  requestId: string;
  orderId: string | null;
  transition: string;
  reason?: string | null;
  detail?: string | null;
}

/**
 * Diagnostic journal: every order state transition and every fill is recorded
 * with the run id and request id so a failure can be replayed from the log.
 */
export class Journal {
  private readonly ledger: Ledger;
  readonly runId: string;

  constructor(ledger: Ledger, runId: string) {
    this.ledger = ledger;
    this.runId = runId;
  }

  record(input: JournalEventInput): void {
    this.ledger.insertEvent({
      runId: this.runId,
      requestId: input.requestId,
      orderId: input.orderId,
      transition: input.transition,
      reason: input.reason ?? null,
      detail: input.detail ?? null,
    });
  }

  eventsFor(orderId: string): OrderEventRecord[] {
    return this.ledger.getEvents(orderId);
  }

  allEvents(): OrderEventRecord[] {
    return this.ledger.getAllEvents();
  }
}
