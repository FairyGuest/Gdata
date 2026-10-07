import { DomainError } from './errors.ts';
import type { ImpactResult, OrchestrationDef } from './types.ts';

export function impactClosure(def: OrchestrationDef, changed: string): ImpactResult {
  const names = new Set(def.services.map((s) => s.name));
  if (!names.has(changed)) {
    throw new DomainError('NOT_FOUND', 'SERVICE_NOT_FOUND', 'service "' + changed + '" is not part of the orchestration', { service: changed });
  }
  const dependents = new Map<string, string[]>();
  for (const s of def.services) {
    for (const dep of s.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(s.name);
      dependents.set(dep, list);
    }
  }
  const affected = new Set<string>([changed]);
  const queue = [changed];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const dependent of dependents.get(current) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }
  const skipped = [...names].filter((n) => !affected.has(n)).sort();
  return { changed, affected: [...affected].sort(), skipped };
}
