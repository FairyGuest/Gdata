import { validationError } from "./errors.ts";
import type { ProvisionInput } from "./kernel.ts";
import type { Tier } from "./store.ts";

/**
 * Contract parsing layer: turns untrusted HTTP bodies into typed kernel
 * inputs, or rejects them with a category=input error. The kernel can assume
 * everything it receives from here is well-formed.
 */

function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationError("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const v = obj[field];
  if (typeof v !== "string" || v.length === 0) {
    throw validationError(`field "${field}" must be a non-empty string`, { field, value: v });
  }
  return v;
}

function requireInt(
  obj: Record<string, unknown>,
  field: string,
  opts: { min: number },
): number {
  const v = obj[field];
  if (typeof v !== "number" || !Number.isInteger(v) || v < opts.min) {
    throw validationError(`field "${field}" must be an integer >= ${opts.min}`, {
      field,
      value: v,
    });
  }
  return v;
}

const TIERS: Tier[] = ["global", "org", "project"];

export function parseProvision(body: unknown): ProvisionInput {
  const obj = requireObject(body);
  const key = requireString(obj, "key");
  const rawScopes = obj.scopes;
  if (!Array.isArray(rawScopes) || rawScopes.length !== 3) {
    throw validationError('field "scopes" must be an array of exactly 3 entries (global, org, project)');
  }
  const scopes = rawScopes.map((s, i) => {
    const so = requireObject(s);
    const tier = requireString(so, "tier");
    if (!TIERS.includes(tier as Tier)) {
      throw validationError(`scopes[${i}].tier must be one of global|org|project`, { tier });
    }
    return {
      tier: tier as Tier,
      id: requireString(so, "id"),
      limit: requireInt(so, "limit", { min: 0 }),
    };
  });
  const tiers = new Set(scopes.map((s) => s.tier));
  if (tiers.size !== 3) {
    throw validationError("scopes must contain exactly one entry per tier (global, org, project)");
  }
  return { key, scopes };
}

export function parseConsume(body: unknown): { key: string; amount: number } {
  const obj = requireObject(body);
  return {
    key: requireString(obj, "key"),
    amount: requireInt(obj, "amount", { min: 1 }),
  };
}

export function parseRotate(body: unknown, defaultGraceMs: number): { key: string; graceMs: number } {
  const obj = requireObject(body);
  const key = requireString(obj, "key");
  const graceMs = obj.graceMs === undefined ? defaultGraceMs : requireInt(obj, "graceMs", { min: 0 });
  return { key, graceMs };
}
