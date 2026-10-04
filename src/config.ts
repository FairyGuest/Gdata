import { randomUUID } from "node:crypto";

export interface AppConfig {
  port: number;
  host: string;
  secret: string;
  dbPath: string;
  clock: "system" | "virtual";
  virtualStartMs: number;
  runId: string;
}

// Local synthetic fixture defaults only; override via env. No real accounts.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.JWT_PORT ?? 3000),
    host: env.JWT_HOST ?? "127.0.0.1",
    secret: env.JWT_SECRET ?? "local-fixture-secret-do-not-use-in-prod",
    dbPath: env.JWT_DB ?? ":memory:",
    clock: env.JWT_CLOCK === "virtual" ? "virtual" : "system",
    virtualStartMs: Number(env.JWT_VIRTUAL_START ?? 1_700_000_000_000),
    runId: env.JWT_RUN_ID ?? randomUUID(),
  };
}