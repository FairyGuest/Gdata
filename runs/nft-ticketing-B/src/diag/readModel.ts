import type { TicketStore } from '../state/store.js';

export class DiagnosticReadModel {
  constructor(private readonly store: TicketStore) {}

  ticket(ticketId: string) {
    const ticket = this.store.readTicket(ticketId);
    return {
      ticketId: `ticket:${ticket.event_id}:${ticket.seat_id}:v${ticket.version}`,
      eventId: ticket.event_id,
      seatId: ticket.seat_id,
      currentOwnerId: ticket.owner_id,
      status: ticket.status,
      priceCents: ticket.price_cents,
      lastCommitSeq: ticket.commit_seq,
      history: this.store.readHistory(ticketId),
    };
  }

  seat(eventId: string, seatId: string) {
    return {
      eventId,
      seatId,
      effectiveTicketCount: this.store.effectiveTicketCount(eventId, seatId),
    };
  }

  user(userId: string) {
    return { userId, balanceCents: this.store.balance(userId) };
  }
}
