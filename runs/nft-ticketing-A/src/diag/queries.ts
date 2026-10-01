import type { Ledger } from "../state/ledger.ts";
import type { OwnershipEvent, TicketView } from "../contract/types.ts";

/** Read-only diagnostic surface: ticket state, ownership history, run attempts. */
export class Diagnostics {
  constructor(private readonly ledger: Ledger) {}

  ticket(ticketId: string): TicketView | null {
    return this.ledger.getTicket(ticketId);
  }

  liveTicket(sessionId: string, seatCode: string): TicketView | null {
    return this.ledger.findLiveTicket(sessionId, seatCode);
  }

  history(ticketId: string): OwnershipEvent[] {
    return this.ledger.ownershipHistory(ticketId);
  }

  balance(userId: string): number {
    return this.ledger.balance(userId);
  }

  heldCount(userId: string, sessionId: string): number {
    return this.ledger.heldCount(userId, sessionId);
  }

  runAttempts(runId: string) {
    return this.ledger.attempts(runId);
  }
}
