import { readFileSync } from "node:fs";

export interface ServiceConfig {
  port: number;
  host: string;
  dbPath: string;
  maxPayloadBytes: number;
  maxSnapshots: number;
  logFile?: string;
}

// Config layer: defaults <- config/default.json <- CONFIG_PATH file <- env overrides.
export function loadConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  let fileCfg: Partial<ServiceConfig> = {};
  const path = process.env.CONFIG_PATH ?? "config/default.json";
  try {
    fileCfg = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as Partial<ServiceConfig>;
  } catch {
    // missing config file is fine; defaults apply
  }
  const cfg: ServiceConfig = {
    port: Number(process.env.PORT ?? fileCfg.port ?? 4319),
    host: process.env.HOST ?? fileCfg.host ?? "127.0.0.1",
    dbPath: process.env.DB_PATH ?? fileCfg.dbPath ?? "data/snapshots.db",
    maxPayloadBytes: Number(process.env.MAX_PAYLOAD_BYTES ?? fileCfg.maxPayloadBytes ?? 1048576),
    maxSnapshots: Number(process.env.MAX_SNAPSHOTS ?? fileCfg.maxSnapshots ?? 10000),
    logFile: process.env.LOG_FILE ?? fileCfg.logFile,
    ...overrides,
  };
  return cfg;
}
