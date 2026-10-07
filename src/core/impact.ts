import { OrchestrationError } from '../contract/errors.ts';
import type { OrchestrationSpec, ImpactResult } from '../contract/types.ts';

export function affectedClosure(spec: OrchestrationSpec, changedService: string): ImpactResult {
  const names = spec.services.map((s) => s.name);
  if (!names.includes(changedService)) {
    throw new OrchestrationError(
      'NOT_FOUND',
      `service "${changedService}" is not defined in spec "${spec.name}"`,
      { changedService, knownServices: [...names].sort() },
    );
  }
  const dependents = new Map<string, string[]>();
  for (const s of spec.services) {
    for (const dep of s.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(s.name);
      dependents.set(dep, list);
    }
  }
  const affected = new Set<string>([changedService]);
  const queue = [changedService];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const dependent of dependents.get(current) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return {
    changedService,
    affected: [...affected].sort(),
    skipped: names.filter((n) => !affected.has(n)).sort(),
  };
}
