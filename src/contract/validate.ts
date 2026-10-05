import type { CompareRequest, JsonValue } from "./types.ts";
import { inputError } from "../diagnostics/errors.ts";

// Contract parsing: turns an untrusted decoded body into a CompareRequest
// or throws INPUT_ERROR with a fine-grained code. Never throws anything else.

const isJsonValue = (v: unknown): v is JsonValue => {
  if (v === null) return true;
  switch (typeof v) {
    case "boolean":
    case "string":
      return true;
    case "number":
      return Number.isFinite(v);
    case "object":
      if (Array.isArray(v)) return v.every(isJsonValue);
      return Object.values(v as Record<string, unknown>).every(isJsonValue);
    default:
      return false;
  }
};

const PATH_PATTERN = /^[A-Za-z0-9_$.\[\]-]+$/;

export function parseCompareRequest(body: unknown): CompareRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw inputError("INVALID_BODY", "request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  if (typeof b.name !== "string" || b.name.length === 0 || b.name.length > 200) {
    throw inputError("INVALID_NAME", "'name' must be a non-empty string of at most 200 characters");
  }
  if (!("data" in b)) {
    throw inputError("MISSING_DATA", "'data' field is required");
  }
  if (!isJsonValue(b.data)) {
    throw inputError("INVALID_DATA", "'data' must be a finite JSON value (no NaN/Infinity/functions)");
  }
  let ignorePaths: string[] = [];
  if (b.ignorePaths !== undefined) {
    if (!Array.isArray(b.ignorePaths) || !b.ignorePaths.every((p) => typeof p === "string" && p.length > 0 && PATH_PATTERN.test(p))) {
      throw inputError("INVALID_IGNORE_PATHS", "'ignorePaths' must be an array of non-empty path strings like 'meta.ts' or 'items[0].id'");
    }
    ignorePaths = b.ignorePaths as string[];
  }
  let update = false;
  if (b.update !== undefined) {
    if (typeof b.update !== "boolean") {
      throw inputError("INVALID_UPDATE_FLAG", "'update' must be a boolean");
    }
    update = b.update;
  }
  return { name: b.name, data: b.data, ignorePaths, update };
}

export function parseNameParam(name: unknown): string {
  if (typeof name !== "string" || name.length === 0) {
    throw inputError("INVALID_NAME", "snapshot name must be a non-empty string");
  }
  return name;
}
