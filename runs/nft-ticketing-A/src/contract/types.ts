/** Canonical command DTOs produced by the contract layer and consumed by the kernel. */

export interface PurchaseCommand {
  kind: "purchase";
  runId: string;
  seq: number;
  sessionId: string;
  seatCode: string;
  userId: string;
}

export interface TransferCommand {
  kind: "transfer";
  runId: string;
  seq: number;
  ticketId: string;
  fromUserId: string;
  toUserId: string;
}

export interface RefundCommand {
  kind: "refund";
  runId: string;
  seq: number;
  ticketId: string;
  userId: string;
}

export interface CheckInCommand {
  kind: "checkin";
  runId: string;
  seq: number;
  ticketId: string;
  userId: string;
}

export type Command = PurchaseCommand | TransferCommand | RefundCommand | CheckInCommand;

export type TicketStatus = "held" | "checked_in" | "voided";

export interface TicketView {
  ticketId: string;
  sessionId: string;
  seatCode: string;
  holderUserId: string;
  status: TicketStatus;
  issueSeq: number;
  checkInSeq: number | null;
  voidSeq: number | null;
}

export interface OwnershipEvent {
  seq: number;
  ticketId: string;
  action: "issue" | "transfer" | "checkin" | "refund";
  fromUserId: string | null;
  toUserId: string | null;
}

export interface CommandResult {
  ok: boolean;
  runId: string;
  seq: number;
  action: Command["kind"];
  commitSeq: number;
  ticketId?: string;
  reason?: string;
  errorClass?: string;
}
