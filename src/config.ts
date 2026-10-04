export interface ServiceConfig {
  /** SQLite file path, or ":memory:" for ephemeral runs. */
  dbPath: string;
  /** Fixture seed for deterministic ledger generation. */
  seed: number;
  /** HTTP port (0 = ephemeral). */
  port: string;
  /** Run identifier stamped on every diagnostic record. */
  runId: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    dbPath: env.BIDS_DB_PATH ?? ":memory:",
    seed: Number(env.BIDS_SEED ?? 20261001),
    port: env.PORT ?? "0",
    runId: env.BIDS_RUN_ID ?? "run-" + Date.now().toString(36),
  };
}
