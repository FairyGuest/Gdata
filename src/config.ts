import { DEFAULT_LIMITS } from './core/engine.ts';
import type { EngineLimits } from './contracts/types.ts';

export interface AppConfig {
  port: number;
  dbPath: string;
  limits: EngineLimits;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.LINT_PORT ?? 8787),
    dbPath: env.LINT_DB ?? 'lint-engine.db',
    limits: {
      maxSourceBytes: Number(env.LINT_MAX_SOURCE_BYTES ?? DEFAULT_LIMITS.maxSourceBytes),
      maxRules: Number(env.LINT_MAX_RULES ?? DEFAULT_LIMITS.maxRules),
      maxMatchesPerRule: Number(env.LINT_MAX_MATCHES_PER_RULE ?? DEFAULT_LIMITS.maxMatchesPerRule),
    },
  };
}

