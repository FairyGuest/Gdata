// Configuration layer. Values can be overridden via environment variables.

export interface ServiceConfig {
  port: number;
  dbPath: string;
  featureWhitelist: string[];
  maxCpu: number;
  maxMemoryMb: number;
  maxConcurrentProvisions: number;
  maxQueueSize: number;
  // Simulated provisioning work duration (virtual time).
  provisionDurationMs: number;
}

export const defaultConfig: ServiceConfig = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? 'data/registry.db',
  featureWhitelist: (process.env.FEATURE_WHITELIST ??
    'git,docker,node,python,rust,java,go').split(','),
  maxCpu: Number(process.env.MAX_CPU ?? 16),
  maxMemoryMb: Number(process.env.MAX_MEMORY_MB ?? 32768),
  maxConcurrentProvisions: Number(process.env.MAX_CONCURRENT_PROVISIONS ?? 2),
  maxQueueSize: Number(process.env.MAX_QUEUE_SIZE ?? 8),
  provisionDurationMs: Number(process.env.PROVISION_DURATION_MS ?? 1000),
};
