// Configuration layer: all knobs come from env vars with documented defaults.
import { randomUUID } from "node:crypto";

export interface ServiceConfig {
  runId: string;
  httpHost: string;
  httpPort: number;
  portStart: number;
  portEnd: number;
  leaseTtlMs: number;
  dbPath: string;
  clockMode: "system" | "virtual";
  virtualStartMs: number;
}

function intEnv(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error("config " + key + " must be an integer, got '" + raw + "'");
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServiceConfig {
  const portStart = intEnv(env, "TUNNEL_PORT_START", 20000);
  const portEnd = intEnv(env, "TUNNEL_PORT_END", 20009);
  const leaseTtlMs = intEnv(env, "TUNNEL_LEASE_TTL_MS", 30000);
  if (portStart < 1 || portEnd > 65535 || portStart > portEnd) {
    throw new Error("invalid port range " + portStart + ".." + portEnd);
  }
  if (leaseTtlMs <= 0) throw new Error("TUNNEL_LEASE_TTL_MS must be positive");
  const clockRaw = env.TUNNEL_CLOCK ?? "system";
  if (clockRaw !== "system" && clockRaw !== "virtual") {
    throw new Error("TUNNEL_CLOCK must be 'system' or 'virtual', got '" + clockRaw + "'");
  }
  return {
    runId: env.RUN_ID ?? randomUUID(),
    httpHost: env.TUNNEL_HOST ?? "127.0.0.1",
    httpPort: intEnv(env, "TUNNEL_HTTP_PORT", 8787),
    portStart,
    portEnd,
    leaseTtlMs,
    dbPath: env.TUNNEL_DB_PATH ?? "./data/leases.db",
    clockMode: clockRaw,
    virtualStartMs: intEnv(env, "TUNNEL_VIRTUAL_START_MS", 1_000_000),
  };
}
