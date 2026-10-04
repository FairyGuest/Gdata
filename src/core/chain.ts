import { computeEntryHash } from "./hash";
import {
  ChainBreak,
  LogEntry,
  SeqGap,
  VerifyReport,
  GENESIS_PREV_HASH,
} from "../contract/types";

export function verifyEntries(entries: LogEntry[]): VerifyReport {
  let firstBreak: ChainBreak | null = null;
  const gaps: SeqGap[] = [];

  let expectedSeq = 1;
  let expectedPrev = GENESIS_PREV_HASH;

  for (const e of entries) {
    if (e.seq !== expectedSeq) {
      if (e.seq > expectedSeq) {
        const missing: number[] = [];
        for (let s = expectedSeq; s < e.seq; s++) missing.push(s);
        gaps.push({ afterSeq: expectedSeq - 1, beforeSeq: e.seq, missing });
      }
      if (firstBreak === null && e.seq <= expectedSeq) {
        firstBreak = {
          seq: e.seq,
          reason: "SEQ_NOT_ONE_BASE",
          expected: String(expectedSeq),
          actual: String(e.seq),
        };
      }
      expectedSeq = e.seq;
    }

    if (firstBreak === null) {
      if (e.prevHash !== expectedPrev) {
        firstBreak = {
          seq: e.seq,
          reason: "PREV_HASH_MISMATCH",
          expected: expectedPrev,
          actual: e.prevHash,
        };
      } else {
        const recomputed = computeEntryHash({
          seq: e.seq,
          timestamp: e.timestamp,
          eventType: e.eventType,
          payload: e.payload,
          prevHash: e.prevHash,
        });
        if (recomputed !== e.hash) {
          firstBreak = {
            seq: e.seq,
            reason: "HASH_RECOMPUTE_MISMATCH",
            expected: recomputed,
            actual: e.hash,
          };
        }
      }
    }

    expectedPrev = e.hash;
    expectedSeq = e.seq + 1;
  }

  return {
    ok: firstBreak === null && gaps.length === 0,
    entryCount: entries.length,
    firstBreak,
    gaps,
    checkedAt: new Date().toISOString(),
  };
}

