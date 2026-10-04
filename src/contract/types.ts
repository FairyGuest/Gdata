export type Effect = "allow" | "deny";

export interface Role {
  name: string;
  inherits: string[];
}

export interface Policy {
  id: string;
  role: string;
  resource: string;
  action: string;
  effect: Effect;
}

export interface CheckRequest {
  subject: { roles: string[] };
  resource: string;
  action: string;
}

export interface MatchedRule {
  policyId: string;
  role: string;
  effect: Effect;
  resource: string;
  action: string;
}

export interface Decision {
  allowed: boolean;
  reasons: string[];
  matched: MatchedRule[];
  expandedRoles: string[];
  snapshotVersion: number;
  runId: string;
}

export interface Snapshot {
  version: number;
  roles: Role[];
  policies: Policy[];
}

export type ErrorCategory =
  | "INPUT_ERROR"
  | "STATE_CONFLICT"
  | "RESOURCE_EXHAUSTED"
  | "INTERNAL_ERROR";

export const ERROR_HTTP_STATUS: Record<ErrorCategory, number> = {
  INPUT_ERROR: 400,
  STATE_CONFLICT: 409,
  RESOURCE_EXHAUSTED: 503,
  INTERNAL_ERROR: 500,
};

