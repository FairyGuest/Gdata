// Configuration layer: all runtime knobs in one place, env-overridable.
import path from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  dbPath: string;
  logFile: string | null;
  fingerprintLength: number;
  maxValueBytes: number;
  maxSecretsPerEnvironment: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    host: env.ESB_HOST ?? '127.0.0.1',
    port: Number(env.ESB_PORT ?? 8080),
    dbPath: env.ESB_DB_PATH ?? path.join('data', 'secrets.db'),
    logFile: env.ESB_LOG_FILE ?? path.join('logs', 'service.log'),
    fingerprintLength: Number(env.ESB_FINGERPRINT_LENGTH ?? 12),
    maxValueBytes: Number(env.ESB_MAX_VALUE_BYTES ?? 4096),
    maxSecretsPerEnvironment: Number(env.ESB_MAX_SECRETS_PER_ENV ?? 256),
  };
}
