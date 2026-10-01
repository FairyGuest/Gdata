export type TicketStatus = 'sold' | 'checked_in' | 'voided';

export interface PurchaseRequest {
  runId: number;
  eventId: string;
  seatId: string;
  userId: string;
}

export interface OwnershipRequest {
  runId: number;
  ticketId: string;
  userId: string;
}

export interface TransferRequest extends OwnershipRequest {
  toUserId: string;
}

export interface PurchaseResult {
  ok: true;
  ticketId: string;
  commitSeq: number;
}

export interface MutationResult {
  ok: true;
  ticketId: string;
  status: TicketStatus;
  commitSeq: number;
}
