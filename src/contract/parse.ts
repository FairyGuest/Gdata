import { OrchestrationError } from './errors.ts';
import type { OrchestrationSpec, ServiceDefinition } from './types.ts';

function fail(message: string, details?: unknown): never {
  throw new OrchestrationError('CONTRACT_PARSE_ERROR', message, details);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseService(raw: unknown, index: number): ServiceDefinition {
  if (!isRecord(raw)) fail(`services[${index}] must be an object`);
  const s = raw as Record<string, unknown>;
  if (typeof s.name !== 'string' || s.name.length === 0) {
    fail(`services[${index}].name must be a non-empty string`);
  }
  if (typeof s.port !== 'number' || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535) {
    fail(`service "${s.name}" port must be an integer in 1..65535`, { service: s.name, port: s.port });
  }
  const dependsOn = s.dependsOn ?? [];
  if (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== 'string')) {
    fail(`service "${s.name}" dependsOn must be an array of service names`);
  }
  const outputs = s.outputs ?? [];
  if (!Array.isArray(outputs) || outputs.some((o) => typeof o !== 'string')) {
    fail(`service "${s.name}" outputs must be an array of strings`);
  }
  const env = s.env ?? {};
  if (!isRecord(env) || Object.values(env).some((v) => typeof v !== 'string')) {
    fail(`service "${s.name}" env must be an object of string values`);
  }
  const hc = s.healthCheck;
  if (!isRecord(hc) || hc.kind !== 'fixture' || (hc.result !== 'healthy' && hc.result !== 'failing')) {
    fail(`service "${s.name}" healthCheck must be { kind: "fixture", result: "healthy" | "failing" }`);
  }
  return {
    name: s.name as string,
    port: s.port as number,
    dependsOn: dependsOn as string[],
    outputs: outputs as string[],
    env: env as Record<string, string>,
    healthCheck: { kind: 'fixture', result: hc.result as 'healthy' | 'failing' },
  };
}

export function parseSpec(raw: unknown): OrchestrationSpec {
  if (!isRecord(raw)) fail('spec must be a JSON object');
  if (typeof raw.name !== 'string' || raw.name.length === 0) fail('spec.name must be a non-empty string');
  if (!Array.isArray(raw.services) || raw.services.length === 0) {
    fail('spec.services must be a non-empty array');
  }
  const services = raw.services.map((s, i) => parseService(s, i));
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const s of services) {
    if (seen.has(s.name)) duplicates.push(s.name);
    seen.add(s.name);
  }
  if (duplicates.length > 0) {
    fail('duplicate service names', { duplicates: [...new Set(duplicates)].sort() });
  }
  return { name: raw.name as string, services };
}
