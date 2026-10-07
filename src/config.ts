// Configuration layer: everything environment-dependent lives here.
// Values come from environment variables with safe local defaults.

import { join } from "node:path";

export interface AppConfig {
  port: number;
  host: string;
  /** SQLite database file (":memory:" allowed for tests). */
  dbPath: string;
  /** Root directory that watched file paths are resolved against. */
  workspaceRoot: string;
  /** Fixture build latency in ms (makes mid-build coalescing observable). */
  buildDelayMs: number;
  /** Queue depth limit; exceeding it raises ResourceExhaustedError. */
  maxQueueSize: number;
  /** Target count limit for the registration contract. */
  maxTargets: number;
  /** JSON-lines log file for replaying runs. */
  logFile: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const dataDir = env.DATA_DIR ?? join(process.cwd(), ".data");
  return {
    port: Number(env.PORT ?? 3050),
    host: env.HOST ?? "127.0.0.1",
    dbPath: env.DB_PATH ?? join(dataDir, "builds.db"),
    workspaceRoot: env.WORKSPACE_ROOT ?? join(dataDir, "workspace"),
    buildDelayMs: Number(env.BUILD_DELAY_MS ?? 50),
    maxQueueSize: Number(env.MAX_QUEUE_SIZE ?? 1000),
    maxTargets: Number(env.MAX_TARGETS ?? 500),
    logFile: env.LOG_FILE ?? join(dataDir, "engine.log"),
  };
}
