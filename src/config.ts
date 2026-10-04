/** Configuration layer: everything environment-dependent lives here. */
export interface AppConfig {
  host: string;
  port: number;
  /** SQLite file path, or ":memory:" for tests. */
  dbPath: string;
  /** Default rotation grace period when the request does not specify one. */
  defaultGraceMs: number;
  /** Directory for structured run logs. */
  logDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 3000),
    dbPath: env.DB_PATH ?? "data/quota.db",
    defaultGraceMs: Number(env.DEFAULT_GRACE_MS ?? 60_000),
    logDir: env.LOG_DIR ?? "logs",
  };
}
