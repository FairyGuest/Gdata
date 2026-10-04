import { inputError } from "./errors.ts";
import type { CheckRequest, Effect, Policy, Role } from "./types.ts";

const NAME_RE = /^[a-zA-Z0-9_.-]+$/;
const PATH_RE = /^[a-zA-Z0-9_.*\/-]+$/;

function assertName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw inputError(`${field} must be a non-empty string (max 128 chars)`, { field, value });
  }
  if (!NAME_RE.test(value)) {
    throw inputError(`${field} contains illegal characters`, { field, value });
  }
  return value;
}

function assertPathPattern(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw inputError(`${field} must be a non-empty string (max 256 chars)`, { field, value });
  }
  if (!PATH_RE.test(value)) {
    throw inputError(`${field} contains illegal characters`, { field, value });
  }
  return value;
}

export function parseRoleBody(body: unknown): Omit<Role, "name"> {
  if (typeof body !== "object" || body === null) throw inputError("role body must be an object");
  const b = body as Record<string, unknown>;
  const inherits = b.inherits ?? [];
  if (!Array.isArray(inherits)) throw inputError("inherits must be an array of role names");
  return { inherits: inherits.map((r) => assertName(r, "inherits[]")) };
}

export function parsePolicyBody(body: unknown): Omit<Policy, "id"> {
  if (typeof body !== "object" || body === null) throw inputError("policy body must be an object");
  const b = body as Record<string, unknown>;
  const role = assertName(b.role, "role");
  const resource = assertPathPattern(b.resource, "resource");
  const action = assertPathPattern(b.action, "action");
  const effect = b.effect;
  if (effect !== "allow" && effect !== "deny") {
    throw inputError("effect must be 'allow' or 'deny'", { effect });
  }
  return { role, resource, action, effect: effect as Effect };
}

export function parseCheckBody(body: unknown): CheckRequest {
  if (typeof body !== "object" || body === null) throw inputError("check body must be an object");
  const b = body as Record<string, unknown>;
  const subject = b.subject as Record<string, unknown> | undefined;
  if (typeof subject !== "object" || subject === null || !Array.isArray(subject.roles)) {
    throw inputError("subject.roles must be an array of role names");
  }
  const roles = subject.roles.map((r) => assertName(r, "subject.roles[]"));
  const resource = assertPathPattern(b.resource, "resource");
  const action = assertPathPattern(b.action, "action");
  if (resource.includes("*") || action.includes("*")) {
    throw inputError("check request resource/action must be concrete (no wildcards)");
  }
  return { subject: { roles }, resource, action };
}

