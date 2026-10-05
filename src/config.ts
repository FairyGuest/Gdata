import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AppConfig {
  server: { host: string; port: number };
  store: { file: string };
  limits: { maxPayloadBytes: number; maxDiffEntries: number; maxSerializedBytes: number };
}

const DEFAULTS: AppConfig = {
  server: { host: "127.0.0.1", port: 8787 },
  store: { file: "data/snapshots.db" },
  limits: { maxPayloadBytes: 1_048_576, maxDiffEntries: 500, maxSerializedBytes: 1_048_576 },
};

export function loadConfig(configPath?: string): AppConfig {
  let fileCfg: Partial<AppConfig> = {};
  const path = configPath ?? process.env.SNAPSHOT_CONFIG ?? resolve("config/default.json");
  try {
    fileCfg = JSON.parse(readFileSync(path, "utf8")) as Partial<AppConfig>;
  } catch {
    // missing/unreadable config file -> fall back to defaults
  }
  const cfg: AppConfig = {
    server: { ...DEFAULTS.server, ...fileCfg.server },
    store: { ...DEFAULTS.store, ...fileCfg.store },
    limits: { ...DEFAULTS.limits, ...fileCfg.limits },
  };
  if (process.env.SNAPSHOT_PORT) cfg.server.port = Number(process.env.SNAPSHOT_PORT);
  if (process.env.SNAPSHOT_HOST) cfg.server.host = process.env.SNAPSHOT_HOST;
  if (process.env.SNAPSHOT_DB) cfg.store.file = process.env.SNAPSHOT_DB;
  return cfg;
}
