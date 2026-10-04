import { stateConflict } from "../contract/errors.ts";
import type { Role } from "../contract/types.ts";

// Expands the transitive ancestor closure of the given roles.
// Diamond-shaped graphs are deduplicated via the visited set, so a shared
// ancestor's permissions are only collected once by callers iterating the
// returned set. Cycles are rejected as STATE_CONFLICT.
export function expandRoles(
  roleNames: string[],
  rolesByName: Map<string, Role>,
  maxDepth: number,
): Set<string> {
  const visited = new Set<string>();
  const stack: Array<{ name: string; depth: number }> = roleNames.map((name) => {
    if (!rolesByName.has(name)) {
      throw stateConflict(`unknown role '${name}' in request`, { role: name });
    }
    return { name, depth: 0 };
  });
  const path: string[] = [];
  const visiting = new Set<string>();

  function visit(name: string, depth: number): void {
    if (visited.has(name)) return;
    if (depth > maxDepth) {
      throw stateConflict("role inheritance exceeds maximum depth", { name, maxDepth });
    }
    if (visiting.has(name)) {
      throw stateConflict("role inheritance cycle detected", {
        cycle: [...path, name],
      });
    }
    const role = rolesByName.get(name);
    if (!role) throw stateConflict(`unknown role '${name}'`, { role: name });
    visiting.add(name);
    path.push(name);
    for (const parent of role.inherits) visit(parent, depth + 1);
    path.pop();
    visiting.delete(name);
    visited.add(name);
  }

  while (stack.length > 0) {
    const { name, depth } = stack.pop()!;
    visit(name, depth);
  }
  return visited;
}

// Detects whether adding 'child inherits parent' would create a cycle.
export function wouldCycle(
  child: string,
  parent: string,
  rolesByName: Map<string, Role>,
): boolean {
  if (child === parent) return true;
  const seen = new Set<string>();
  const queue = [parent];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (cur === child) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const p of rolesByName.get(cur)?.inherits ?? []) queue.push(p);
  }
  return false;
}

