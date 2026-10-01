export interface AppConfig {
  dbPath: string;
  seed: number;
  port: number;
  host: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    dbPath: env['MARKET_DB'] ?? ':memory:',
    seed: Number.parseInt(env['MARKET_SEED'] ?? '1337', 10),
    port: Number.parseInt(env['PORT'] ?? '3000', 10),
    host: env['HOST'] ?? '127.0.0.1',
  };
}
