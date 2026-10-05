export interface ServiceConfig {
  port: number;
  dbPath: string;
  defaultRuns: number;
  maxRuns: number;
  targetReliability: number;
  maxRetries: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    port: Number(env.FLAKY_PORT ?? 4300),
    dbPath: env.FLAKY_DB_PATH ?? 'data/flaky.db',
    defaultRuns: Number(env.FLAKY_DEFAULT_RUNS ?? 5),
    maxRuns: Number(env.FLAKY_MAX_RUNS ?? 100),
    targetReliability: Number(env.FLAKY_TARGET_RELIABILITY ?? 0.99),
    maxRetries: Number(env.FLAKY_MAX_RETRIES ?? 5),
  };
}
