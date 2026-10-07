import { Resources, ServiceError } from "./types.js";

/** Contract parsing layer: turns untrusted input into typed commands or throws ServiceError(VALIDATION). */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parsePositiveNumber(field: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new ServiceError("VALIDATION", `field '${field}' must be a positive finite number`, { field, value: v });
  }
  return v;
}

function parseId(field: string, v: unknown): string {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new ServiceError("VALIDATION", `field '${field}' must be a non-empty string`, { field, value: v });
  }
  return v.trim();
}

export function parseResources(v: unknown, prefix = "resources"): Resources {
  if (!isPlainObject(v)) {
    throw new ServiceError("VALIDATION", `'${prefix}' must be an object {cpu, memoryMb}`, { value: v });
  }
  return {
    cpu: parsePositiveNumber(`${prefix}.cpu`, v.cpu),
    memoryMb: parsePositiveNumber(`${prefix}.memoryMb`, v.memoryMb),
  };
}

export function parseRegisterNode(v: unknown): { id: string; capacity: Resources } {
  if (!isPlainObject(v)) throw new ServiceError("VALIDATION", "body must be an object");
  return { id: parseId("id", v.id), capacity: parseResources(v.capacity, "capacity") };
}

export function parseCreateNamespace(v: unknown): { name: string; quota: Resources } {
  if (!isPlainObject(v)) throw new ServiceError("VALIDATION", "body must be an object");
  return { name: parseId("name", v.name), quota: parseResources(v.quota, "quota") };
}

export function parsePlaceWorkload(v: unknown): { id: string; namespace: string; request: Resources } {
  if (!isPlainObject(v)) throw new ServiceError("VALIDATION", "body must be an object");
  return {
    id: parseId("id", v.id),
    namespace: parseId("namespace", v.namespace),
    request: parseResources(v.request, "request"),
  };
}
