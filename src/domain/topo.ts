import { DomainError } from './errors.ts';
import type { LayeredPlan, OrchestrationDef } from './types.ts';

export function computeLayers(def: OrchestrationDef): string[][] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const s of def.services) {
    indegree.set(s.name, s.dependsOn.length);
    for (const dep of s.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(s.name);
      dependents.set(dep, list);
    }
  }
  let frontier = def.services.filter((s) => s.dependsOn.length === 0).map((s) => s.name).sort();
  const layers: string[][] = [];
  let placed = 0;
  while (frontier.length > 0) {
    layers.push(frontier);
    placed += frontier.length;
    const next: string[] = [];
    for (const name of frontier) {
      for (const dependent of dependents.get(name) ?? []) {
        const remaining = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, remaining);
        if (remaining === 0) next.push(dependent);
      }
    }
    frontier = next.sort();
  }
  if (placed !== def.services.length) {
    const stuck = def.services.map((s) => s.name).filter((n) => (indegree.get(n) ?? 0) > 0);
    throw new DomainError('COMPUTE_FAILURE', 'TOPOLOGY_UNRESOLVABLE', 'dependency graph could not be fully ordered (cycle?)', { stuck });
  }
  return layers;
}

export function computePlan(def: OrchestrationDef): LayeredPlan {
  const layers = computeLayers(def);
  const startOrder = layers.flat();
  const stopOrder = [...startOrder].reverse();
  return { layers, startOrder, stopOrder };
}
