import { createHash } from "node:crypto";
import { AuditError } from "../contract/errors";

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") +
    "}"
  );
}

export function sha256Hex(input: string): string {
  try {
    return createHash("sha256").update(input, "utf8").digest("hex");
  } catch (err) {
    throw new AuditError(
      "HASH_COMPUTE_FAILURE",
      "SHA-256 computation failed",
      String(err)
    );
  }
}

export interface HashMaterial {
  seq: number;
  timestamp: string;
  eventType: string;
  payload: unknown;
  prevHash: string;
}

export function computeEntryHash(m: HashMaterial): string {
  const material = [
    String(m.seq),
    m.timestamp,
    m.eventType,
    canonicalize(m.payload),
    m.prevHash,
  ].join("|");
  return sha256Hex(material);
}

