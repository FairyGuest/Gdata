import { AppError } from "../contract/errors.ts";
import type { JsonValue } from "../contract/types.ts";

// Deterministic serialization: object keys sorted recursively so that
// logically-equal payloads always serialize to the same string.
export function stableSerialize(value: JsonValue): string {
  try {
    return JSON.stringify(sortValue(value));
  } catch (err) {
    throw new AppError("COMPUTE_FAILURE", "failed to serialize payload", {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

function sortValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortValue((value as Record<string, JsonValue>)[key] as JsonValue);
    }
    return out;
  }
  return value;
}

export function deserializeSnapshot(serialized: string, key: string): JsonValue {
  try {
    return JSON.parse(serialized) as JsonValue;
  } catch (err) {
    throw new AppError("COMPUTE_FAILURE", "stored snapshot is not valid JSON", {
      key,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}
