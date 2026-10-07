import { validationError, limitExceeded } from '../errors.ts';
import type { ServiceConfig } from '../config.ts';

export interface TemplateInput {
  name: string;
  image: string;
  features: string[];
  cpu: number;
  memoryMb: number;
  idleTimeoutMs: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse & validate a template registration payload against global limits and the feature whitelist. */
export function parseTemplate(body: unknown, cfg: ServiceConfig): TemplateInput {
  if (!isRecord(body)) throw validationError('template body must be a JSON object');
  const { name, image, features, cpu, memoryMb, idleTimeoutMs } = body;

  if (typeof name !== 'string' || name.trim() === '') throw validationError('template.name must be a non-empty string', 'name');
  if (typeof image !== 'string' || image.trim() === '') throw validationError('template.image must be a non-empty string', 'image');

  if (!Array.isArray(features) || features.some((f) => typeof f !== 'string')) {
    throw validationError('template.features must be an array of strings', 'features');
  }
  for (const f of features as string[]) {
    if (!cfg.featureWhitelist.includes(f)) {
      throw validationError('feature not in whitelist: ' + f, 'features.' + f);
    }
  }

  if (typeof cpu !== 'number' || !Number.isFinite(cpu) || cpu <= 0) {
    throw validationError('template.cpu must be a positive number', 'cpu');
  }
  if (cpu > cfg.maxCpu) throw limitExceeded('cpu ' + cpu + ' > global max ' + cfg.maxCpu, 'cpu');

  if (typeof memoryMb !== 'number' || !Number.isFinite(memoryMb) || memoryMb <= 0) {
    throw validationError('template.memoryMb must be a positive number', 'memoryMb');
  }
  if (memoryMb > cfg.maxMemoryMb) throw limitExceeded('memoryMb ' + memoryMb + ' > global max ' + cfg.maxMemoryMb, 'memoryMb');

  if (typeof idleTimeoutMs !== 'number' || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw validationError('template.idleTimeoutMs must be a positive number', 'idleTimeoutMs');
  }

  return { name: name.trim(), image: image.trim(), features: features as string[], cpu, memoryMb, idleTimeoutMs };
}
