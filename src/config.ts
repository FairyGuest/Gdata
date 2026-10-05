/**
 * Configuration layer: defaults overridable via config/local.json and env vars.
 * Keeps limits explicit so resource exhaustion is a defined, testable behavior.
 */
import { readFileSync, existsSync } from "node:fs";

export interface AppConfig {
  host: string;
  port: number;
  dbPath: string;
  limits: {
    maxRows: number;
    maxDepth: number;
    maxArrayItems: number;
    maxPatternAttempts: number;
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  host: "127.0.0.1",
  port: 4100,
  dbPath: "data/factory.db",
  limits: { maxRows: 10000, maxDepth: 8, maxArrayItems: 1000, maxPatternAttempts: 5000 },
};

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  let fileConfig: Partial<AppConfig> = {};
  if (existsSync("config/local.json")) {
    fileConfig = JSON.parse(readFileSync("config/local.json", "utf8")) as Partial<AppConfig>;
  }
  const merged: AppConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...overrides,
    limits: { ...DEFAULT_CONFIG.limits, ...(fileConfig.limits ?? {}), ...(overrides.limits ?? {}) },
  };
  if (process.env.PORT) merged.port = Number(process.env.PORT);
  if (process.env.HOST) merged.host = process.env.HOST;
  if (process.env.DB_PATH) merged.dbPath = process.env.DB_PATH;
  return merged;
}
