import { DomainError, invalidInput } from './errors.js';
import type { OwnershipRequest, PurchaseRequest, TransferRequest } from './types.js';

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') invalidInput(`${field} must be a non-empty string`);
  return value.trim();
}

function requiredRunId(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) invalidInput('runId must be a non-negative integer');
  return value as number;
}

function objectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) invalidInput('request body must be an object');
  return body as Record<string, unknown>;
}

export function parsePurchase(body: unknown): PurchaseRequest {
  const input = objectBody(body);
  return {
    runId: requiredRunId(input.runId),
    eventId: requiredString(input.eventId, 'eventId'),
    seatId: requiredString(input.seatId, 'seatId'),
    userId: requiredString(input.userId, 'userId'),
  };
}

export function parseOwnership(body: unknown): OwnershipRequest {
  const input = objectBody(body);
  return {
    runId: requiredRunId(input.runId),
    ticketId: requiredString(input.ticketId, 'ticketId'),
    userId: requiredString(input.userId, 'userId'),
  };
}

export function parseTransfer(body: unknown): TransferRequest {
  const base = parseOwnership(body);
  const toUserId = requiredString((body as Record<string, unknown>).toUserId, 'toUserId');
  if (toUserId === base.userId) invalidInput('toUserId must differ from userId');
  return { ...base, toUserId };
}

export function errorResponse(error: unknown): { statusCode: number; body: { error: { reason: string; message: string } } } {
  if (error instanceof DomainError) {
    return { statusCode: error.statusCode, body: { error: { reason: error.reason, message: error.message } } };
  }
  const message = error instanceof Error ? error.message : 'unknown compute failure';
  return { statusCode: 500, body: { error: { reason: 'compute_failed', message } } };
}
