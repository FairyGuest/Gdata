export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;
  maxEvents: number;
}

const DEFAULTS: AppConfig = {
  port: 3000,
  host: "0.0.0.0",
  dbPath: "audit.db",
  maxEvents: 1_000_000,
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? DEFAULTS.port);
  const maxEvents = Number(env.AUDIT_MAX_EVENTS ?? DEFAULTS.maxEvents);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("invalid PORT: " + env.PORT);
  }
  if (!Number.isInteger(maxEvents) || maxEvents <= 0) {
    throw new Error("invalid AUDIT_MAX_EVENTS: " + env.AUDIT_MAX_EVENTS);
  }
  return {
    port,
    host: env.HOST ?? DEFAULTS.host,
    dbPath: env.AUDIT_DB ?? DEFAULTS.dbPath,
    maxEvents,
  };
}
