import { DomainError, type ValidationIssue } from './errors.ts';
import type { OrchestrationDef, ServiceDef } from './types.ts';

const ENV_REF = /[$][{]([A-Za-z_][A-Za-z0-9_]*)[.]([A-Za-z_][A-Za-z0-9_]*)[}]/g;

function checkSchema(def: unknown, issues: ValidationIssue[]): boolean {
  if (typeof def !== 'object' || def === null) {
    issues.push({ code: 'SCHEMA', message: 'definition must be an object' });
    return false;
  }
  const d = def as Record<string, unknown>;
  if (typeof d.name !== 'string' || d.name.length === 0) {
    issues.push({ code: 'SCHEMA', message: 'orchestration name must be a non-empty string' });
  }
  if (!Array.isArray(d.services) || d.services.length === 0) {
    issues.push({ code: 'SCHEMA', message: 'services must be a non-empty array' });
    return false;
  }
  const seen = new Set<string>();
  for (const raw of d.services as unknown[]) {
    const s = raw as Partial<ServiceDef> | null;
    if (typeof s?.name !== 'string' || s.name.length === 0) {
      issues.push({ code: 'SCHEMA', message: 'every service needs a non-empty string name' });
      continue;
    }
    if (seen.has(s.name)) {
      issues.push({ code: 'SCHEMA', message: 'duplicate service name', details: { service: s.name } });
    }
    seen.add(s.name);
    if (!Array.isArray(s.ports) || s.ports.some((p) => !Number.isInteger(p) || (p as number) < 1 || (p as number) > 65535)) {
      issues.push({ code: 'SCHEMA', message: 'ports must be an array of integers in 1..65535', details: { service: s.name } });
    }
    if (!Array.isArray(s.dependsOn) || s.dependsOn.some((x) => typeof x !== 'string')) {
      issues.push({ code: 'SCHEMA', message: 'dependsOn must be an array of service names', details: { service: s.name } });
    }
    if (typeof s.env !== 'object' || s.env === null || Array.isArray(s.env)) {
      issues.push({ code: 'SCHEMA', message: 'env must be an object of string values', details: { service: s.name } });
    }
    if (!Array.isArray(s.outputs) || s.outputs.some((x) => typeof x !== 'string')) {
      issues.push({ code: 'SCHEMA', message: 'outputs must be an array of key names', details: { service: s.name } });
    }
    const h = s.health as { kind?: unknown; fixture?: unknown } | undefined;
    if (h?.kind !== 'fixture' || (h.fixture !== 'healthy' && h.fixture !== 'unhealthy')) {
      issues.push({ code: 'SCHEMA', message: 'health must be { kind: fixture, fixture: healthy | unhealthy }', details: { service: s.name } });
    }
  }
  return issues.length === 0;
}

function checkDependencies(def: OrchestrationDef, issues: ValidationIssue[]): void {
  const names = new Set(def.services.map((s) => s.name));
  for (const s of def.services) {
    for (const dep of s.dependsOn) {
      if (!names.has(dep)) {
        issues.push({
          code: 'UNKNOWN_DEPENDENCY',
          message: 'service "' + s.name + '" depends on unknown service "' + dep + '"',
          details: { service: s.name, dependency: dep },
        });
      }
    }
  }
}

function checkCycles(def: OrchestrationDef, issues: ValidationIssue[]): void {
  const deps = new Map(def.services.map((s) => [s.name, s.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const reported = new Set<string>();

  const visit = (node: string): void => {
    const st = state.get(node);
    if (st === 'done') return;
    if (st === 'visiting') {
      const idx = stack.indexOf(node);
      const cycle = [...stack.slice(idx), node];
      const key = [...cycle].sort().join('|');
      if (!reported.has(key)) {
        reported.add(key);
        issues.push({
          code: 'CYCLE',
          message: 'dependency cycle detected: ' + cycle.join(' -> '),
          details: { cycle },
        });
      }
      return;
    }
    state.set(node, 'visiting');
    stack.push(node);
    for (const dep of deps.get(node) ?? []) {
      if (deps.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(node, 'done');
  };

  for (const s of def.services) visit(s.name);
}

function checkPorts(def: OrchestrationDef, issues: ValidationIssue[]): void {
  const owner = new Map<number, string>();
  const reported = new Set<string>();
  for (const s of def.services) {
    for (const port of s.ports) {
      const other = owner.get(port);
      if (other !== undefined && other !== s.name) {
        const key = port + ':' + [other, s.name].sort().join(':');
        if (!reported.has(key)) {
          reported.add(key);
          issues.push({
            code: 'PORT_CONFLICT',
            message: 'port ' + port + ' is declared by both "' + other + '" and "' + s.name + '"',
            details: { port, services: [other, s.name] },
          });
        }
      } else {
        owner.set(port, s.name);
      }
    }
  }
}

function checkEnvRefs(def: OrchestrationDef, issues: ValidationIssue[]): void {
  const outputs = new Map(def.services.map((s) => [s.name, new Set(s.outputs)]));
  for (const s of def.services) {
    for (const [envKey, value] of Object.entries(s.env)) {
      if (typeof value !== 'string') continue;
      for (const match of value.matchAll(ENV_REF)) {
        const refService = match[1];
        const refKey = match[2];
        const keys = outputs.get(refService);
        if (!keys) {
          issues.push({
            code: 'ENV_UNRESOLVED',
            message: 'service "' + s.name + '" env "' + envKey + '" references unknown service "' + refService + '"',
            details: { service: s.name, envKey, reference: match[0] },
          });
        } else if (!keys.has(refKey)) {
          issues.push({
            code: 'ENV_UNRESOLVED',
            message: 'service "' + s.name + '" env "' + envKey + '" references key "' + refKey + '" not declared in outputs of "' + refService + '"',
            details: { service: s.name, envKey, reference: match[0], availableOutputs: [...keys] },
          });
        }
      }
    }
  }
}

export function validateDefinition(raw: unknown): OrchestrationDef {
  const issues: ValidationIssue[] = [];
  if (!checkSchema(raw, issues)) {
    throw new DomainError('INPUT_ERROR', 'VALIDATION_FAILED', 'orchestration definition failed validation', { issues });
  }
  const def = raw as OrchestrationDef;
  checkDependencies(def, issues);
  checkCycles(def, issues);
  checkPorts(def, issues);
  checkEnvRefs(def, issues);
  if (issues.length > 0) {
    throw new DomainError('INPUT_ERROR', 'VALIDATION_FAILED', 'orchestration definition failed validation', { issues });
  }
  return def;
}
