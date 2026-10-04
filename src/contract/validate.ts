import { inputError } from "./errors.ts";
import type { CheckRequest, Effect, PolicyDocument } from "./types.ts";

const NAME_RE = /^[a-zA-Z0-9_.:-]{1,128}$/;
const PATTERN_RE = /^[a-zA-Z0-9_.:/*-]{1,256}$/;

function assertName(value: unknown, field: string): string {
  if (typeof value !== "string" || !NAME_RE.test(value)) {
    throw inputError("INVALID_NAME", `field "${field}" must be 1-128 chars of [a-zA-Z0-9_.:-]`);
  }
  return value;
}

function assertPattern(value: unknown, field: string): string {
  if (typeof value !== "string" || !PATTERN_RE.test(value)) {
    throw inputError("INVALID_PATTERN", `field "${field}" must be 1-256 chars of [a-zA-Z0-9_.:/*-]`);
  }
  if (value.includes("*") && !value.endsWith("*") && value !== "*") {
    throw inputError("INVALID_PATTERN", `field "${field}": wildcard "*" is only allowed as a trailing segment`);
  }
  return value;
}

function assertEffect(value: unknown, field: string): Effect {
  if (value !== "allow" && value !== "deny") {
    throw inputError("INVALID_EFFECT", `field "${field}" must be "allow" or "deny"`);
  }
  return value;
}

function assertObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw inputError("INVALID_BODY", `${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function parseCheckRequest(body: unknown): CheckRequest {
  const o = assertObject(body, "check request");
  if (!Array.isArray(o.roles) || o.roles.length === 0) {
    throw inputError("INVALID_ROLES", 'field "roles" must be a non-empty array of role names');
  }
  const roles = o.roles.map((r, i) => assertName(r, `roles[${i}]`));
  if (new Set(roles).size !== roles.length) {
    throw inputError("INVALID_ROLES", 'field "roles" must not contain duplicates');
  }
  return {
    roles,
    resource: assertPattern(o.resource, "resource"),
    action: assertPattern(o.action, "action"),
  };
}

export function parseRoleName(body: unknown): string {
  const o = assertObject(body, "role");
  return assertName(o.name, "name");
}
export function parseRoleEdge(body: unknown): { role: string; parent: string } {
  const o = assertObject(body, "role edge");
  const role = assertName(o.role, "role");
  const parent = assertName(o.parent, "parent");
  if (role === parent) {
    throw inputError("SELF_INHERITANCE", "a role cannot inherit from itself");
  }
  return { role, parent };
}

export function parseRule(body: unknown): { role: string; effect: Effect; resource: string; action: string } {
  const o = assertObject(body, "rule");
  return {
    role: assertName(o.role, "role"),
    effect: assertEffect(o.effect, "effect"),
    resource: assertPattern(o.resource, "resource"),
    action: assertPattern(o.action, "action"),
  };
}

export function parsePolicyDocument(body: unknown): PolicyDocument {
  const o = assertObject(body, "policy document");
  if (!Array.isArray(o.roles) || !Array.isArray(o.rules)) {
    throw inputError("INVALID_BODY", 'policy document requires "roles" and "rules" arrays');
  }
  return {
    roles: o.roles.map((r) => parseRoleEdge(r)),
    rules: o.rules.map((r) => parseRule(r)),
  };
}
