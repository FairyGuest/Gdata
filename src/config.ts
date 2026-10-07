export interface ServiceConfig {
  host: string;
  port: number;
  /** SQLite file path, or ":memory:" for ephemeral runs/tests. */
  dbPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 3000),
    dbPath: env.DB_PATH ?? ":memory:",
  };
}
