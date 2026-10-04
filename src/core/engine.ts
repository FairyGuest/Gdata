import { matchPattern } from "./glob.ts";
import { expandRoles } from "./inheritance.ts";
import type {
  CheckRequest,
  Decision,
  MatchedRule,
  Policy,
  Role,
  Snapshot,
} from "../contract/types.ts";

export interface EngineOptions {
  maxInheritanceDepth: number;
  newRunId: () => string;
}

// Pure decision kernel: evaluates a check request against an immutable
// snapshot. deny always overrides allow; no match means default-deny.
export function decide(
  req: CheckRequest,
  snapshot: Snapshot,
  opts: EngineOptions,
): Decision {
  const rolesByName = new Map<string, Role>(snapshot.roles.map((r) => [r.name, r]));
  const expanded = expandRoles(req.subject.roles, rolesByName, opts.maxInheritanceDepth);

  const matched: MatchedRule[] = [];
  for (const policy of snapshot.policies) {
    if (!expanded.has(policy.role)) continue;
    if (!matchPattern(policy.resource, req.resource)) continue;
    if (!matchPattern(policy.action, req.action)) continue;
    matched.push({
      policyId: policy.id,
      role: policy.role,
      effect: policy.effect,
      resource: policy.resource,
      action: policy.action,
    });
  }

  const reasons: string[] = [];
  const denies = matched.filter((m) => m.effect === "deny");
  const allows = matched.filter((m) => m.effect === "allow");
  let allowed: boolean;
  if (denies.length > 0) {
    allowed = false;
    reasons.push(
      `deny overrides allow: ${denies.map((d) => d.policyId).join(", ")}`,
    );
  } else if (allows.length > 0) {
    allowed = true;
    reasons.push(`allowed by: ${allows.map((a) => a.policyId).join(", ")}`);
  } else {
    allowed = false;
    reasons.push("default deny: no rule matched");
  }

  return {
    allowed,
    reasons,
    matched,
    expandedRoles: [...expanded].sort(),
    snapshotVersion: snapshot.version,
    runId: opts.newRunId(),
  };
}

