// Configuration layer: loads config/default.json plus an optional override
// file (PREVIEW_ENV_CONFIG), and assembles the wired-up service.

import { readFileSync } from 'node:fs';
import { parseTemplate } from './contract/template.ts';
import type { EnvironmentTemplate } from './contract/types.ts';

export interface ServiceConfig {
  template: EnvironmentTemplate;
  quota: { maxActivePerUser: number };
  renew: { maxRenewals: number };
  server: { host: string; port: number; sweepIntervalMs: number };
  database: { file: string };
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

export function loadConfig(path = 'config/default.json'): ServiceConfig {
  const raw = readJson(path);
  const overridePath = process.env.PREVIEW_ENV_CONFIG;
  const merged = overridePath ? deepMerge(raw, readJson(overridePath)) : raw;
  return {
    ...merged,
    template: parseTemplate(merged.template),
  };
}

function deepMerge(base: any, override: any): any {
  if (Array.isArray(base) || Array.isArray(override) || typeof base !== 'object' || typeof override !== 'object' || !base || !override) {
    return override;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = deepMerge(base[k], v);
  return out;
}

