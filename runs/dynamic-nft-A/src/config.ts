export interface AppConfig {
  dbFile: string;
  seed: number;
  feedLockMaxWaitMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    dbFile: env.NFT_DB_FILE ?? ":memory:",
    seed: Number(env.NFT_SEED ?? "20261001"),
    feedLockMaxWaitMs: Number(env.NFT_LOCK_WAIT_MS ?? "1000"),
  };
}
