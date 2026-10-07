export interface ServiceConfig {
  port: number;
  host: string;
  dbPath: string;
  fingerprintLength: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? "127.0.0.1",
    dbPath: env.DB_PATH ?? "data/secrets.db",
    fingerprintLength: Number(env.FINGERPRINT_LENGTH ?? 12),
  };
}
