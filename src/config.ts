export interface ServiceConfig {
  maxCpu: number;
  maxMemoryMb: number;
  featureWhitelist: string[];
  maxConcurrentProvisions: number;
  provisionDurationMs: number;
  dbPath: string;
  port: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServiceConfig {
  return {
    maxCpu: Number(env.MAX_CPU ?? 8),
    maxMemoryMb: Number(env.MAX_MEMORY_MB ?? 16384),
    featureWhitelist: (env.FEATURE_WHITELIST ?? 'docker-in-docker,gh-cli,node,dotnet,python,java,rust,go').split(','),
    maxConcurrentProvisions: Number(env.MAX_CONCURRENT_PROVISIONS ?? 2),
    provisionDurationMs: Number(env.PROVISION_DURATION_MS ?? 5000),
    dbPath: env.DB_PATH ?? 'data/registry.db',
    port: Number(env.PORT ?? 3000),
  };
}
