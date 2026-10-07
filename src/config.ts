// Configuration layer: all tunables in one place, overridable via env.
export interface ServiceConfig {
  host: string;
  port: number;
  dbPath: string; // ':memory:' for tests
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 3100),
    dbPath: env.DB_PATH ?? 'cluster.db',
  };
}

