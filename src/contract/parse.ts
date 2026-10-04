import { KernelError } from "../kernel/errors.js";

const input = (reason: string, msg: string) => new KernelError("input", reason, msg);

function reqString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw input("invalid_field", 'field "' + field + '" must be a non-empty string');
  }
  return v;
}

function reqInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw input("invalid_field", 'field "' + field + '" must be an integer');
  }
  return v;
}

function reqAmount(v: unknown, field: string): number {
  const n = reqInt(v, field);
  if (n <= 0 || !Number.isSafeInteger(n)) {
    throw input("invalid_amount", 'field "' + field + '" must be a positive safe integer');
  }
  return n;
}

/** bps rates must be integers in [0, 10000]. */
function reqBps(v: unknown, field: string): number {
  const n = reqInt(v, field);
  if (n < 0 || n > 10000) {
    throw input("invalid_bps", 'field "' + field + '" must be within 0..10000 bps');
  }
  return n;
}

function body(obj: unknown): Record<string, unknown> {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw input("invalid_body", "request body must be a JSON object");
  }
  return obj as Record<string, unknown>;
}

export interface BorrowParams { borrower: string; tokenId: string; amount: number; perTickBps: number; }
export interface RepayParams { loanId: number; amount: number; payer: string; }
export interface LiquidateParams { loanId: number; caller: string; }

export function parseBorrow(raw: unknown): BorrowParams {
  const b = body(raw);
  return {
    borrower: reqString(b.borrower, "borrower"),
    tokenId: reqString(b.tokenId, "tokenId"),
    amount: reqAmount(b.amount, "amount"),
    perTickBps: reqBps(b.perTickBps, "perTickBps"),
  };
}

export function parseRepay(raw: unknown): RepayParams {
  const b = body(raw);
  return {
    loanId: reqInt(b.loanId, "loanId"),
    amount: reqAmount(b.amount, "amount"),
    payer: reqString(b.payer, "payer"),
  };
}

export function parseLiquidate(raw: unknown): LiquidateParams {
  const b = body(raw);
  return {
    loanId: reqInt(b.loanId, "loanId"),
    caller: reqString(b.caller, "caller"),
  };
}
