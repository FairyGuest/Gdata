// Configuration layer. Defaults live here and in config/default.json;
// environment variables override both. No secrets required: everything is local.

import { readFileSync, existsSync } from "node:fs";
import { inputError } from "./errors.ts";

export interface ServiceConfig {
  portMin: number;      // first allocatable tunnel port (inclusive)
  portMax: number;      // last allocatable tunnel port (inclusive)
  leaseTtlMs: number;   // max lifetime beyond the last heartbeat
  dbPath: string;       // SQLite file path, or ":memory:"
  httpHost: string;
  httpPort: number;
}

export const DEFAULT_CONFIG: ServiceConfig = {
  portMin: 20000,
  portMax: 20009,
  leaseTtlMs: 30_000,
  dbPath: ":memory:",
  httpHost: "127.0.0.1",
  httpPort: 8080,
};

export function loadConfig(env: Record<string, string | undefined> = process.env): ServiceConfig {
  let fileCfg: Partial<ServiceConfig> = {};
  const cfgPath = env.CONFIG_PATH ?? "config/default.json";
  if (cfgPath && existsSync(cfgPath)) {
    try {
      fileCfg = JSON.parse(readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, "")) as Partial<ServiceConfig>;
    } catch (err) {
      throw inputError("cannot parse config file " + cfgPath, String(err));
    }
  }
  const num = (v: string | undefined, fallback: number): number =>
    v === undefined ? fallback : Number(v);
  const cfg: ServiceConfig = {
    portMin: num(env.TUNNEL_PORT_MIN, fileCfg.portMin ?? DEFAULT_CONFIG.portMin),
    portMax: num(env.TUNNEL_PORT_MAX, fileCfg.portMax ?? DEFAULT_CONFIG.portMax),
    leaseTtlMs: num(env.LEASE_TTL_MS, fileCfg.leaseTtlMs ?? DEFAULT_CONFIG.leaseTtlMs),
    dbPath: env.DB_PATH ?? fileCfg.dbPath ?? DEFAULT_CONFIG.dbPath,
    httpHost: env.HTTP_HOST ?? fileCfg.httpHost ?? DEFAULT_CONFIG.httpHost,
    httpPort: num(env.HTTP_PORT, fileCfg.httpPort ?? DEFAULT_CONFIG.httpPort),
  };
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: ServiceConfig): void {
  if (!Number.isInteger(cfg.portMin) || !Number.isInteger(cfg.portMax) ||
      cfg.portMin < 1 || cfg.portMax > 65535 || cfg.portMin > cfg.portMax) {
    throw inputError("invalid port range", { portMin: cfg.portMin, portMax: cfg.portMax });
  }
  if (!Number.isFinite(cfg.leaseTtlMs) || cfg.leaseTtlMs <= 0) {
    throw inputError("leaseTtlMs must be a positive number", { leaseTtlMs: cfg.leaseTtlMs });
  }
}

