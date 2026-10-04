import { Errors, DomainError } from "./errors.ts";
import type {
  CheckInCommand,
  Command,
  PurchaseCommand,
  RefundCommand,
  TransferCommand,
} from "./types.ts";

/** Read-only catalog the parser uses to validate session/seat/user references. */
export interface Catalog {
  hasSession(sessionId: string): boolean;
  hasSeat(sessionId: string, seatCode: string): boolean;
  hasUser(userId: string): boolean;
  seatPrice(sessionId: string, seatCode: string): number;
}

interface RawRequest {
  body?: unknown;
  params?: Record<string, string | undefined>;
}

function expectString(value: unknown, field: string): string {
  if (value === undefined) {
    throw Errors.missingField(field);
  }
  if (typeof value !== "string") {
    throw Errors.invalidType(field, "a non-empty string");
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw Errors.missingField(field);
  }
  return trimmed;
}

function expectPositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw Errors.invalidType(field, "a positive integer");
  }
  return value;
}

function requireEnvelope(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw Errors.invalidType("body", "a JSON object");
  }
  return body as Record<string, unknown>;
}

/**
 * Parse run/seq envelope. `seq` is the caller-supplied ordering number of a
 * purchase attempt within a run; the kernel serializes commits by it instead of
 * by wall-clock arrival time.
 */
function parseEnvelope(body: Record<string, unknown>, runIdAllowedFallback?: string) {
  const runId = expectString(body.runId ?? runIdAllowedFallback ?? "", "runId");
  const seq = expectPositiveInt(body.seq, "seq");
  return { runId, seq };
}

/** Purchase requires session + seat + user; seat must belong to the session. */
export function parsePurchase(req: RawRequest, catalog: Catalog): PurchaseCommand {
  const body = requireEnvelope(req.body);
  const { runId, seq } = parseEnvelope(body);
  const sessionId = expectString(body.sessionId, "sessionId");
  const seatCode = expectString(body.seatCode, "seatCode");
  const userId = expectString(body.userId, "userId");

  if (!catalog.hasSession(sessionId)) {
    throw Errors.unknownSession(sessionId);
  }
  if (!catalog.hasSeat(sessionId, seatCode)) {
    throw Errors.unknownSeat(sessionId, seatCode);
  }
  if (!catalog.hasUser(userId)) {
    throw Errors.unknownUser(userId);
  }
  return { kind: "purchase", runId, seq, sessionId, seatCode, userId };
}

function parseTicketRef(body: Record<string, unknown>, params?: Record<string, string | undefined>) {
  const { runId, seq } = parseEnvelope(body);
  const ticketId = expectString(body.ticketId ?? params?.ticketId ?? "", "ticketId");
  return { runId, seq, ticketId };
}

export function parseTransfer(req: RawRequest, catalog: Catalog): TransferCommand {
  const body = requireEnvelope(req.body);
  const { runId, seq, ticketId } = parseTicketRef(body, req.params);
  const fromUserId = expectString(body.fromUserId, "fromUserId");
  const toUserId = expectString(body.toUserId, "toUserId");
  if (fromUserId === toUserId) {
    throw Errors.sameUserTransfer();
  }
  if (!catalog.hasUser(fromUserId)) {
    throw Errors.unknownUser(fromUserId);
  }
  if (!catalog.hasUser(toUserId)) {
    throw Errors.unknownUser(toUserId);
  }
  return { kind: "transfer", runId, seq, ticketId, fromUserId, toUserId };
}

export function parseRefund(req: RawRequest, catalog: Catalog): RefundCommand {
  const body = requireEnvelope(req.body);
  const { runId, seq, ticketId } = parseTicketRef(body, req.params);
  const userId = expectString(body.userId, "userId");
  if (!catalog.hasUser(userId)) {
    throw Errors.unknownUser(userId);
  }
  return { kind: "refund", runId, seq, ticketId, userId };
}

export function parseCheckIn(req: RawRequest, catalog: Catalog): CheckInCommand {
  const body = requireEnvelope(req.body);
  const { runId, seq, ticketId } = parseTicketRef(body, req.params);
  const userId = expectString(body.userId, "userId");
  if (!catalog.hasUser(userId)) {
    throw Errors.unknownUser(userId);
  }
  return { kind: "checkin", runId, seq, ticketId, userId };
}

export function parseCommand(kind: Command["kind"], req: RawRequest, catalog: Catalog): Command {
  switch (kind) {
    case "purchase":
      return parsePurchase(req, catalog);
    case "transfer":
      return parseTransfer(req, catalog);
    case "refund":
      return parseRefund(req, catalog);
    case "checkin":
      return parseCheckIn(req, catalog);
    default:
      throw Errors.invariantViolated(`unknown command kind ${String(kind)}`);
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}


