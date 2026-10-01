import { BorrowCommand, LiquidateCommand, RepayCommand, WriteCommand } from './types.js';
import { inputError, REASONS } from './errors.js';

const MAX_UINT = 9_007_199_254_740_991;
const DIGITS = /^[0-9]+$/;
const IDENT = /^[A-Za-z0-9_:.-]+$/;

// Accepts JSON numbers and decimal digit strings (the latter arrive via path
// params); fractional or non-decimal strings are rejected as input errors.
export function parsePositiveInteger(value: unknown, field: string): number {
  let normalized = value;
  if (typeof value === 'string') {
    if (!DIGITS.test(value)) {
      inputError(REASONS.invalid_field, field + ' must be a positive integer', { field, received: value });
    }
    normalized = Number(value);
  }
  if (typeof normalized !== 'number' || !Number.isFinite(normalized) || !Number.isInteger(normalized)) {
    inputError(REASONS.invalid_field, field + ' must be an integer', { field, received: String(value) });
  }
  if ((normalized as number) <= 0 || (normalized as number) > MAX_UINT) {
    inputError(REASONS.amount_out_of_range, field + ' must be in [1, 2^53-1]', { field, received: value });
  }
  return normalized as number;
}

export function parseIdString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 64 || !IDENT.test(value)) {
    inputError(REASONS.invalid_field, field + ' must be a non-empty identifier (A-Za-z0-9_:.-, max 64)', { field, received: String(value) });
  }
  return value;
}

export function parseBps(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    inputError(REASONS.invalid_field, field + ' must be an integer', { field, received: String(value) });
  }
  if ((value as number) < 0 || (value as number) > 10000) {
    inputError(REASONS.bps_out_of_range, field + ' must be in [0, 10000] bps', { field, received: value });
  }
  return value as number;
}

function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    inputError(REASONS.invalid_field, 'request body must be a JSON object', {});
  }
  return body as Record<string, unknown>;
}

export function parseWriteCommand(kind: WriteCommand['kind'], body: unknown, runId: string): WriteCommand {
  const obj = requireObject(body);
  switch (kind) {
    case 'borrow':
      return {
        kind,
        runId,
        borrower: parseIdString(obj.borrower, 'borrower'),
        tokenId: parseIdString(obj.tokenId, 'tokenId'),
        amount: parsePositiveInteger(obj.amount, 'amount'),
      };
    case 'repay':
      return {
        kind,
        runId,
        loanId: parsePositiveInteger(obj.loanId, 'loanId'),
        payer: parseIdString(obj.payer, 'payer'),
        amount: parsePositiveInteger(obj.amount, 'amount'),
      };
    case 'liquidate':
      return {
        kind,
        runId,
        loanId: parsePositiveInteger(obj.loanId, 'loanId'),
        liquidator: parseIdString(obj.liquidator, 'liquidator'),
      };
  }
}

export function parseLoanId(value: unknown): number {
  return parsePositiveInteger(value, 'loanId');
}

