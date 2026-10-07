export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;
  maxServices: number;
  maxBodyBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.ORCH_PORT ?? 3000),
    host: env.ORCH_HOST ?? '127.0.0.1',
    dbPath: env.ORCH_DB ?? 'data/orchestrator.db',
    maxServices: Number(env.ORCH_MAX_SERVICES ?? 200),
    maxBodyBytes: Number(env.ORCH_MAX_BODY_BYTES ?? 1048576),
  };
}
