export interface AuditEventInput {
  actor: string;
  action: string;
  resource: string;
  metadata?: Record<string, unknown>;
}

export interface AuditEvent extends AuditEventInput {
  seq: number;
  timestamp: string;
  prevHash: string;
  hash: string;
}

export type VerifyFailureCode =
  | "SEQUENCE_GAP"
  | "PREV_HASH_MISMATCH"
  | "HASH_MISMATCH";

export interface VerifyResult {
  ok: boolean;
  length: number;
  brokenAt?: number;
  code?: VerifyFailureCode;
  reason?: string;
}

export const GENESIS_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000";
