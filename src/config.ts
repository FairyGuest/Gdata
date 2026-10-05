import { readFileSync } from 'node:fs';
import type { Limits } from '../contract/schema.ts';

export interface AppConfig {
  port: number;
  dbPath: string;
  limits: Limits;
}

const DEFAULTS: AppConfig = {
  port: 3000,
  dbPath: 'data/factory.db',
  limits: {
    maxCount: 10000,
    maxArrayItems: 1000,
    maxStringLength: 4096,
    maxPatternAttempts: 20000,
    maxNestingDepth: 16,
  },
};

export function loadConfig(path = 'config/default.json'): AppConfig {
  let fileConfig: Partial<AppConfig> = {};
  try {
    fileConfig = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    // missing config file: fall back to defaults
  }
  const merged: AppConfig = {
    port: Number(process.env.PORT ?? fileConfig.port ?? DEFAULTS.port),
    dbPath: process.env.DB_PATH ?? fileConfig.dbPath ?? DEFAULTS.dbPath,
    limits: { ...DEFAULTS.limits, ...(fileConfig.limits ?? {}) },
  };
  return merged;
}
