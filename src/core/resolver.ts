// Execution kernel — contract parsing & nearest-scope resolution.
// Pure functions: no I/O, no persistence. Deterministic given the same inputs.
import {
  Declaration,
  ResolvedSecret,
  SCOPE_RANK,
  ScopeLevel,
} from '../contracts/types.js';

export interface ResolutionDecision {
  name: string;
  winner: Declaration;
  overridden: Array<{ level: ScopeLevel; declarationId: string }>;
}

export interface ResolutionResult {
  resolved: ResolvedSecret[];
  missing: string[];
  decisions: ResolutionDecision[];
}

export function scopePathOf(d: Pick<Declaration, 'scopeLevel' | 'org' | 'project' | 'env'>): string {
  const parts = ['org:' + d.org];
  if (d.scopeLevel !== 'org') parts.push('project:' + d.project);
  if (d.scopeLevel === 'env') parts.push('env:' + d.env);
  return parts.join('/');
}

/**
 * Resolve each required secret name against the declarations visible from an
 * environment scope. Nearest scope wins, decided independently per key:
 * env-level beats project-level beats org-level.
 */
export function resolveSecrets(declarations: Declaration[], required: string[]): ResolutionResult {
  const byName = new Map<string, Declaration[]>();
  for (const d of declarations) {
    const list = byName.get(d.name) ?? [];
    list.push(d);
    byName.set(d.name, list);
  }

  const resolved: ResolvedSecret[] = [];
  const missing: string[] = [];
  const decisions: ResolutionDecision[] = [];

  for (const name of required) {
    const candidates = byName.get(name) ?? [];
    if (candidates.length === 0) {
      missing.push(name);
      continue;
    }
    // Highest rank (nearest scope) wins; ranks are unique per (name, scope) here.
    const sorted = [...candidates].sort((a, b) => SCOPE_RANK[b.scopeLevel] - SCOPE_RANK[a.scopeLevel]);
    const winner = sorted[0]!;
    decisions.push({
      name,
      winner,
      overridden: sorted.slice(1).map((d) => ({ level: d.scopeLevel, declarationId: d.id })),
    });
    resolved.push({
      name,
      value: winner.value,
      sourceLevel: winner.scopeLevel,
      sourcePath: scopePathOf(winner),
      declarationId: winner.id,
      declarationVersion: winner.version,
    });
  }

  return { resolved, missing, decisions };
}
