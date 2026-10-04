import type { MutationResult, PurchaseResult } from '../contract/types.js';
import type { TicketStore } from '../state/store.js';

export class TicketingKernel {
  constructor(private readonly store: TicketStore) {}

  purchase(input: { runId: number; eventId: string; seatId: string; userId: string }): PurchaseResult {
    const result = this.store.purchase(input.runId, input.eventId, input.seatId, input.userId);
    return { ok: true, ticketId: result.ticketId, commitSeq: result.commitSeq };
  }

  transfer(input: { runId: number; ticketId: string; userId: string; toUserId: string }): MutationResult {
    const result = this.store.transfer(input.runId, input.ticketId, input.userId, input.toUserId);
    return { ok: true, ticketId: input.ticketId, status: result.status, commitSeq: result.commitSeq };
  }

  refund(input: { runId: number; ticketId: string; userId: string }): MutationResult {
    const result = this.store.refund(input.runId, input.ticketId, input.userId);
    return { ok: true, ticketId: input.ticketId, status: result.status, commitSeq: result.commitSeq };
  }

  checkIn(input: { runId: number; ticketId: string; userId: string }): MutationResult {
    const result = this.store.checkIn(input.runId, input.ticketId, input.userId);
    return { ok: true, ticketId: input.ticketId, status: result.status, commitSeq: result.commitSeq };
  }
}
