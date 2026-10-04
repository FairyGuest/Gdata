export interface ServiceConfig {
  dbPath: string;
  port: number;
  host: string;
  maxPayloadBytes: number;
  maxEntries: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    dbPath: env.AUDIT_DB_PATH ?? "data/audit.db",
    port: Number(env.AUDIT_PORT ?? 3000),
    host: env.AUDIT_HOST ?? "127.0.0.1",
    maxPayloadBytes: Number(env.AUDIT_MAX_PAYLOAD_BYTES ?? 64 * 1024),
    maxEntries: Number(env.AUDIT_MAX_ENTRIES ?? 1_000_000),
  };
}

