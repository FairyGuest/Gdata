import { inputError } from "../kernel/errors.ts";
import { canonicalEvent, type NftEvent } from "./types.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw inputError("invalid_field", `field "${key}" must be a non-empty string`, { field: key, got: value });
  }
  return value;
}

function requireSeq(obj: Record<string, unknown>): number {
  const value = obj.seq;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw inputError("invalid_field", 'field "seq" must be a positive integer', { got: value });
  }
  return value;
}

function requirePrice(obj: Record<string, unknown>): number {
  const value = obj.price;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw inputError("invalid_field", 'field "price" must be a non-negative finite number', { got: value });
  }
  return value;
}

export function parseEventBody(raw: unknown): NftEvent {
  if (!isObject(raw)) {
    throw inputError("invalid_body", "request body must be a JSON object");
  }
  const seq = requireSeq(raw);
  const type = raw.type;
  if (type !== "mint" && type !== "transfer" && type !== "sale") {
    throw inputError("unsupported_type", 'field "type" must be one of mint|transfer|sale', { got: type });
  }
  const tokenId = requireString(raw, "tokenId");

  if (type === "mint") {
    return { seq, type, tokenId, to: requireString(raw, "to") };
  }
  const from = requireString(raw, "from");
  const to = requireString(raw, "to");
  if (type === "transfer") {
    return { seq, type, tokenId, from, to };
  }
  return { seq, type, tokenId, from, to, price: requirePrice(raw) };
}

export function eventFingerprint(event: NftEvent): string {
  return canonicalEvent(event);
}

