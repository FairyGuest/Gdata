/**
 * Configuration layer: every knob the service needs, with defaults that
 * are safe for local runs and overridable via environment variables.
 * The clock is injected by the composition root (server.ts / tests).
 */
export interface ServiceConfig {
  port: number;
  host: string;
  /** HMAC-SHA256 secret. Local-dev default only; override via JWT_SECRET. */
  secret: string;
  /** SQLite file path, or ':memory:'. */
  dbPath: string;
  /** Upper bound accepted by the contract layer for ttlSeconds. */
  maxTtlSeconds: number;
  /** Default TTL used by refresh when the caller does not specify one. */
  defaultRefreshTtlSeconds: number;
  /** Capacity guard: max simultaneously active tokens per subject. */
  maxActiveTokensPerSubject: number;
  /** Diagnostic ring buffer capacity. */
  diagnosticsCapacity: number;
}

const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('environment variable ' + name + ' must be a positive integer, got ' + raw);
  }
  return n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    port: intFromEnv('PORT', 8787),
    host: env.HOST ?? '127.0.0.1',
    secret: env.JWT_SECRET ?? 'local-dev-secret-change-me',
    dbPath: env.DB_PATH ?? ':memory:',
    maxTtlSeconds: intFromEnv('MAX_TTL_SECONDS', 86_400),
    defaultRefreshTtlSeconds: intFromEnv('DEFAULT_REFRESH_TTL_SECONDS', 300),
    maxActiveTokensPerSubject: intFromEnv('MAX_ACTIVE_TOKENS_PER_SUBJECT', 16),
    diagnosticsCapacity: intFromEnv('DIAGNOSTICS_CAPACITY', 1000),
  };
}
