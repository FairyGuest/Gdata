import type { OrchestrationSpec, PlanResult } from '../contract/types.ts';

export function layeredTopoSort(spec: OrchestrationSpec): PlanResult {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const s of spec.services) {
    indegree.set(s.name, s.dependsOn.length);
    for (const dep of s.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(s.name);
      dependents.set(dep, list);
    }
  }

  const layers: string[][] = [];
  let ready = spec.services.map((s) => s.name).filter((n) => indegree.get(n) === 0).sort();
  let placed = 0;
  while (ready.length > 0) {
    layers.push(ready);
    placed += ready.length;
    const next: string[] = [];
    for (const name of ready) {
      for (const dependent of dependents.get(name) ?? []) {
        const remaining = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, remaining);
        if (remaining === 0) next.push(dependent);
      }
    }
    ready = next.sort();
  }
  if (placed !== spec.services.length) {
    throw new Error('topo sort called on a cyclic graph; run validateSpec first');
  }

  const startOrder = layers.flat();
  return { layers, startOrder, stopOrder: [...startOrder].reverse() };
}
