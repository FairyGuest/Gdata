export interface LogEntry {
  seq: number;
  timestamp: string;
  eventType: string;
  payload: unknown;
  prevHash: string;
  hash: string;
}

export interface AppendRequest {
  eventType: string;
  payload: unknown;
  timestamp?: string;
}

export interface AppendResult {
  seq: number;
  hash: string;
  prevHash: string;
}

export interface ChainBreak {
  seq: number;
  reason: "PREV_HASH_MISMATCH" | "HASH_RECOMPUTE_MISMATCH" | "SEQ_NOT_ONE_BASE";
  expected?: string;
  actual?: string;
}

export interface SeqGap {
  afterSeq: number;
  beforeSeq: number;
  missing: number[];
}

export interface VerifyReport {
  ok: boolean;
  entryCount: number;
  firstBreak: ChainBreak | null;
  gaps: SeqGap[];
  checkedAt: string;
}

export const GENESIS_PREV_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000";

