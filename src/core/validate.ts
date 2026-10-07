import { OrchestrationError } from '../contract/errors.ts';
import type { OrchestrationSpec, PortConflict, MissingEnvRef } from '../contract/types.ts';

const ENV_REF_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function findCycle(spec: OrchestrationSpec): string[] | null {
  const deps = new Map(spec.services.map((s) => [s.name, s.dependsOn]));
  const names = spec.services.map((s) => s.name).sort();
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (name: string): string[] | null => {
    state.set(name, 'visiting');
    stack.push(name);
    for (const dep of [...(deps.get(name) ?? [])].sort()) {
      if (state.get(dep) === 'done') continue;
      if (state.get(dep) === 'visiting') {
        const start = stack.indexOf(dep);
        return [...stack.slice(start), dep];
      }
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(name, 'done');
    return null;
  };

  for (const name of names) {
    if (!state.has(name)) {
      const found = visit(name);
      if (found) return found;
    }
  }
  return null;
}

export function findPortConflicts(spec: OrchestrationSpec): PortConflict[] {
  const byPort = new Map<number, string[]>();
  for (const s of spec.services) {
    const list = byPort.get(s.port) ?? [];
    list.push(s.name);
    byPort.set(s.port, list);
  }
  const conflicts: PortConflict[] = [];
  for (const [port, services] of byPort) {
    if (services.length > 1) conflicts.push({ port, services: services.sort() });
  }
  return conflicts.sort((a, b) => a.port - b.port);
}

export function findMissingEnvRefs(spec: OrchestrationSpec): MissingEnvRef[] {
  const declared = new Set<string>();
  for (const s of spec.services) for (const key of s.outputs) declared.add(key);
  const missing = new Map<string, Set<string>>();
  for (const s of spec.services) {
    for (const value of Object.values(s.env)) {
      for (const match of value.matchAll(ENV_REF_PATTERN)) {
        const key = match[1];
        if (!declared.has(key)) {
          const refs = missing.get(key) ?? new Set<string>();
          refs.add(s.name);
          missing.set(key, refs);
        }
      }
    }
  }
  return [...missing.entries()]
    .map(([key, refs]) => ({ key, referencedBy: [...refs].sort() }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function validateSpec(spec: OrchestrationSpec): void {
  const names = new Set(spec.services.map((s) => s.name));
  const unknownDeps: { service: string; dependency: string }[] = [];
  for (const s of spec.services) {
    for (const dep of s.dependsOn) {
      if (!names.has(dep)) unknownDeps.push({ service: s.name, dependency: dep });
    }
  }
  if (unknownDeps.length > 0) {
    throw new OrchestrationError(
      'VALIDATION_UNKNOWN_DEPENDENCY',
      'dependency references a service that is not defined',
      { unknownDependencies: unknownDeps },
    );
  }

  const cycle = findCycle(spec);
  if (cycle) {
    throw new OrchestrationError(
      'VALIDATION_CYCLE',
      `dependency cycle detected: ${cycle.join(' -> ')}`,
      { cycle },
    );
  }

  const conflicts = findPortConflicts(spec);
  if (conflicts.length > 0) {
    throw new OrchestrationError(
      'VALIDATION_PORT_CONFLICT',
      `port conflict on ${conflicts.map((c) => c.port).join(', ')}`,
      { conflicts },
    );
  }

  const missing = findMissingEnvRefs(spec);
  if (missing.length > 0) {
    throw new OrchestrationError(
      'VALIDATION_MISSING_ENV',
      `environment references undeclared output keys: ${missing.map((m) => m.key).join(', ')}`,
      { missing },
    );
  }
}
