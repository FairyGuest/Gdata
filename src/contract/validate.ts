import { AppError } from "./errors.ts";
import type { CompareRequest, JsonValue, UpdateRequest } from "./types.ts";

const KEY_PATTERN = /^[A-Za-z0-9._:\/-]{1,200}$/;

function fail(message: string, detail?: unknown): never {
  throw new AppError("INPUT_ERROR", message, detail);
}

export function validateKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0) fail("field 'key' must be a non-empty string");
  if (!KEY_PATTERN.test(key)) {
    fail("field 'key' contains illegal characters (allowed: A-Z a-z 0-9 . _ : / -, max 200 chars)", { key });
  }
  return key;
}

export function validateIgnorePaths(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("field 'ignorePaths' must be an array of strings");
  for (const p of value) {
    if (typeof p !== "string" || p.length === 0) {
      fail("every entry of 'ignorePaths' must be a non-empty string", { ignorePaths: value });
    }
  }
  return value as string[];
}

function assertJsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (value === null) return;
  const t = typeof value;
  if (t === "string" || t === "boolean") return;
  if (t === "number") {
    if (!Number.isFinite(value as number)) fail("non-finite numbers are not valid JSON", { path });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJsonValue(v, path + "[" + i + "]"));
    return;
  }
  if (t === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertJsonValue(v, path ? path + "." + k : k);
    }
    return;
  }
  fail("field 'data' must be a JSON-serializable value", { path, actualType: t });
}

function optionalBool(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail("field '" + name + "' must be a boolean");
  return value;
}

export function parseCompareRequest(body: unknown): CompareRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    fail("request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const key = validateKey(b.key);
  if (!("data" in b)) fail("field 'data' is required");
  assertJsonValue(b.data, "");
  return {
    key,
    data: b.data as JsonValue,
    ignorePaths: validateIgnorePaths(b.ignorePaths),
    createIfMissing: optionalBool(b.createIfMissing, "createIfMissing", true),
    updateOnMismatch: optionalBool(b.updateOnMismatch, "updateOnMismatch", false),
  };
}

export function parseUpdateRequest(body: unknown): UpdateRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    fail("request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const key = validateKey(b.key);
  if (!("data" in b)) fail("field 'data' is required");
  assertJsonValue(b.data, "");
  return { key, data: b.data as JsonValue };
}
