// Contract parsing: validates raw JSON into a RunConfig or throws AppError
// with code INPUT_ERROR. Nothing here performs I/O.

import { AppError } from "./errors.ts";
import type { RunConfig } from "./types.ts";

export const LIMITS = {
  maxConcurrency: 512,
  maxTotalRequests: 1_000_000,
  maxRequestIntervalMs: 60_000,
  minTimeoutMs: 1,
  maxTimeoutMs: 120_000,
} as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function intField(obj: Record<string, unknown>, name: string, min: number, max: number, dflt?: number): number {
  const raw = obj[name];
  if (raw === undefined || raw === null) {
    if (dflt !== undefined) return dflt;
    throw new AppError("INPUT_ERROR", `missing required field: ${name}`);
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new AppError("INPUT_ERROR", `field ${name} must be an integer`, { received: raw });
  }
  if (raw < min || raw > max) {
    throw new AppError("INPUT_ERROR", `field ${name} must be between ${min} and ${max}`, { received: raw });
  }
  return raw;
}

export function parseRunConfig(raw: unknown): RunConfig {
  if (!isPlainObject(raw)) {
    throw new AppError("INPUT_ERROR", "request body must be a JSON object");
  }
  const targetUrl = raw.targetUrl;
  if (typeof targetUrl !== "string" || targetUrl.length === 0) {
    throw new AppError("INPUT_ERROR", "missing required field: targetUrl (string)");
  }
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new AppError("INPUT_ERROR", "targetUrl is not a valid URL", { received: targetUrl });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppError("INPUT_ERROR", "targetUrl must use http or https", { received: parsed.protocol });
  }
  return {
    targetUrl,
    concurrency: intField(raw, "concurrency", 1, LIMITS.maxConcurrency, 1),
    totalRequests: intField(raw, "totalRequests", 1, LIMITS.maxTotalRequests, 10),
    requestIntervalMs: intField(raw, "requestIntervalMs", 0, LIMITS.maxRequestIntervalMs, 0),
    timeoutMs: intField(raw, "timeoutMs", LIMITS.minTimeoutMs, LIMITS.maxTimeoutMs, 10_000),
  };
}
