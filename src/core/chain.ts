import { createHash } from "node:crypto";
import {
  AuditEvent,
  AuditEventInput,
  GENESIS_HASH,
  VerifyResult,
} from "../contract/types";
import { computationFailure } from "../contract/errors";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") +
    "}"
  );
}

export function canonicalPayload(
  seq: number,
  timestamp: string,
  prevHash: string,
  input: AuditEventInput
): string {
  return canonical({
    seq,
    timestamp,
    prevHash,
    actor: input.actor,
    action: input.action,
    resource: input.resource,
    metadata: input.metadata ?? null,
  });
}

export function computeHash(
  seq: number,
  timestamp: string,
  prevHash: string,
  input: AuditEventInput
): string {
  try {
    const payload = canonicalPayload(seq, timestamp, prevHash, input);
    return createHash("sha256").update(payload, "utf8").digest("hex");
  } catch (err) {
    throw computationFailure("failed to compute SHA-256 hash", {
      seq,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

export function buildEvent(
  seq: number,
  prevHash: string,
  input: AuditEventInput,
  timestamp = new Date().toISOString()
): AuditEvent {
  return {
    ...input,
    seq,
    timestamp,
    prevHash,
    hash: computeHash(seq, timestamp, prevHash, input),
  };
}

export function verifyChain(events: AuditEvent[]): VerifyResult {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const expectedSeq = i + 1;
    if (e.seq !== expectedSeq) {
      return {
        ok: false,
        length: events.length,
        brokenAt: expectedSeq,
        code: "SEQUENCE_GAP",
        reason: "sequence gap: expected seq " + expectedSeq + ", found seq " + e.seq,
      };
    }
    if (e.prevHash !== prevHash) {
      return {
        ok: false,
        length: events.length,
        brokenAt: e.seq,
        code: "PREV_HASH_MISMATCH",
        reason: "prevHash mismatch at seq " + e.seq,
      };
    }
    const expected = computeHash(e.seq, e.timestamp, e.prevHash, e);
    if (e.hash !== expected) {
      return {
        ok: false,
        length: events.length,
        brokenAt: e.seq,
        code: "HASH_MISMATCH",
        reason: "hash mismatch at seq " + e.seq + " (entry content was altered)",
      };
    }
    prevHash = e.hash;
  }
  return { ok: true, length: events.length };
}
