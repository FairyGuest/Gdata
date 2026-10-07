/** Configuration layer: env-driven with explicit defaults. */

import { resolve } from 'node:path';
import type { ServiceConfig } from './domain/types.ts';

export interface AppConfig extends ServiceConfig {
  port: number;
  host: string;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const env = process.env;
  return {
    dbPath: overrides.dbPath ?? env.BW_DB_PATH ?? ':memory:',
    workspaceRoot: resolve(overrides.workspaceRoot ?? env.BW_WORKSPACE ?? 'fixtures/workspace'),
    buildDelayMs: overrides.buildDelayMs ?? Number(env.BW_BUILD_DELAY_MS ?? 0),
    maxRebuildSetSize: overrides.maxRebuildSetSize ?? Number(env.BW_MAX_REBUILD_SET ?? 1000),
    maxTargets: overrides.maxTargets ?? Number(env.BW_MAX_TARGETS ?? 5000),
    port: overrides.port ?? Number(env.BW_PORT ?? 8787),
    host: overrides.host ?? env.BW_HOST ?? '127.0.0.1',
  };
}