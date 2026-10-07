// Configuration layer: loads service config + template from disk.
// Env vars override file values: PREVIEW_CONFIG, PREVIEW_TEMPLATE, PREVIEW_DB, PREVIEW_PORT, PREVIEW_QUOTA.

import { readFileSync } from 'node:fs';
import { parseTemplate, type Template } from './contract/template.ts';

export interface ServiceConfig {
  quotaPerOwner: number;
  deploySeconds: number;
  dbPath: string;
  templatePath: string;
  port: number;
}

export function loadConfig(configPath = process.env.PREVIEW_CONFIG ?? 'config/service.config.json'): ServiceConfig {
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  return {
    quotaPerOwner: Number(process.env.PREVIEW_QUOTA ?? raw.quotaPerOwner ?? 2),
    deploySeconds: Number(raw.deploySeconds ?? 30),
    dbPath: process.env.PREVIEW_DB ?? String(raw.dbPath ?? 'data/preview-env.db'),
    templatePath: process.env.PREVIEW_TEMPLATE ?? String(raw.templatePath ?? 'fixtures/template.json'),
    port: Number(process.env.PREVIEW_PORT ?? raw.port ?? 4173),
  };
}

export function loadTemplate(config: ServiceConfig): Template {
  return parseTemplate(JSON.parse(readFileSync(config.templatePath, 'utf8')));
}
