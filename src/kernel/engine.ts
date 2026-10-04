import { internalError } from "../contract/errors.ts";
import type {
  CheckRequest,
  Decision,
  MatchedRule,
  PolicyRule,
  PolicySnapshot,
} from "../contract/types.ts";

/** Max roles visited during inheritance closure; guards against runaway graphs. */
export const MAX_ROLE_CLOSURE = 10_000;

/**
 * Compute the transitive inheritance closure of the given roles.
 * Diamond-shaped graphs are deduplicated via a visited set, so a shared
 * ancestor contributes its rules exactly once.
 * Throws an internal-category error if the closure exceeds the safety bound.
 */
export function roleClosure(
  roles: ReadonlyMap<string, readonly string[]>,
  start: readonly string[],
): string[] {
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length > 0) {
    const role = stack.pop()!;
    if (seen.has(role)) continue;
    seen.add(role);
    if (seen.size > MAX_ROLE_CLOSURE) {
      throw internalError(
        "ROLE_CLOSURE_OVERFLOW",
        `role inheritance closure exceeded ${MAX_ROLE_CLOSURE} roles`,
      );
    }
    for (const parent of roles.get(role) ?? []) stack.push(parent);
  }
  return [...seen];
}

/** True if a pattern matches a concrete value. Supports trailing "prefix/*" and bare "*". */
export function patternMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1); // keeps the trailing "/"
    return value.startsWith(prefix);
  }
  return pattern === value;
}

export function ruleMatches(rule: PolicyRule, resource: string, action: string): boolean {
  return patternMatches(rule.resource, resource) && patternMatches(rule.action, action);
}

/**
 * Pure decision function over an immutable policy snapshot.
 * Deny wins over allow; no match means default deny.
 */
export function decide(snapshot: PolicySnapshot, req: CheckRequest): Decision {
  const effectiveRoles = roleClosure(snapshot.roles, req.roles);
  const roleSet = new Set(effectiveRoles);

  const matched: MatchedRule[] = [];
  for (const rule of snapshot.rules) {
    if (!roleSet.has(rule.role)) continue;
    if (!ruleMatches(rule, req.resource, req.action)) continue;
    matched.push({
      id: rule.id,
      role: rule.role,
      effect: rule.effect,
      resource: rule.resource,
      action: rule.action,
    });
  }

  const hasDeny = matched.some((m) => m.effect === "deny");
  const hasAllow = matched.some((m) => m.effect === "allow");
  return {
    allow: hasDeny ? false : hasAllow,
    reason: hasDeny ? "DENY_RULE_MATCHED" : hasAllow ? "ALLOW_RULE_MATCHED" : "NO_RULE_MATCHED",
    policyVersion: snapshot.version,
    effectiveRoles,
    matchedRules: matched,
  };
}
