/**
 * Configuration layer. Everything has a local synthetic default so the system
 * runs without production accounts or external services.
 */

export interface AppConfig {
  dbPath: string;
  port: number;
  host: string;
  lockWaitMs: number;
  enableFaultInjection: boolean;
  diagConsole: boolean;
  diagLogPath: string | null;
}

function integerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return parsed;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    // In-memory by default: acceptance/tests always start from the fixed seed.
    dbPath: env.DB_PATH ?? ':memory:',
    port: integerFromEnv('PORT', 8080),
    host: env.HOST ?? '127.0.0.1',
    lockWaitMs: integerFromEnv('LOCK_WAIT_MS', 5000),
    enableFaultInjection: boolFromEnv('ENABLE_FAULT_INJECTION', true),
    diagConsole: boolFromEnv('DIAG_CONSOLE', true),
    diagLogPath: env.DIAG_LOG_PATH ? env.DIAG_LOG_PATH : null,
  };
}
