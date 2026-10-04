/** Data contracts crossing module boundaries (contract -> state -> kernel -> server). */

export type Effect = "allow" | "deny";

export interface RoleEdge {
  /** Child role name. */
  role: string;
  /** Parent role name; child inherits all permissions of parent (transitively). */
  parent: string;
}

export interface PolicyRule {
  id: number;
  role: string;
  effect: Effect;
  /** Resource pattern; supports trailing wildcard, e.g. "docs/*". */
  resource: string;
  /** Action pattern; supports trailing wildcard or "*". */
  action: string;
}

export interface PolicySnapshot {
  /** Monotonic version; bumped on every committed mutation. */
  version: number;
  roles: ReadonlyMap<string, readonly string[]>;
  rules: readonly PolicyRule[];
}

export interface CheckRequest {
  /** Roles directly assigned to the subject. */
  roles: string[];
  resource: string;
  action: string;
}

export interface MatchedRule {
  id: number;
  role: string;
  effect: Effect;
  resource: string;
  action: string;
}

export type DecisionReason =
  | "DENY_RULE_MATCHED"
  | "ALLOW_RULE_MATCHED"
  | "NO_RULE_MATCHED";

export interface Decision {
  allow: boolean;
  reason: DecisionReason;
  /** Policy version the decision was computed against. */
  policyVersion: number;
  /** Effective roles after inheritance closure (deduplicated). */
  effectiveRoles: string[];
  matchedRules: MatchedRule[];
}

export interface PolicyDocument {
  roles: RoleEdge[];
  rules: Array<Omit<PolicyRule, "id">>;
}
