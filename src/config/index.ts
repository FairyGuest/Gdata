export interface AppConfig {
  readonly port: number;
  readonly host: string;
  readonly dbPath: string;
  readonly seed: number;
  readonly lockTimeoutMs: number;
  readonly sqliteBusyTimeoutMs: number;
  readonly logFilePath: string | null;
}

const DEFAULT_CONFIG: AppConfig = {
  port: 8080,
  host: "127.0.0.1",
  dbPath: "data/nft-bids.db",
  seed: 20261001,
  lockTimeoutMs: 5000,
  sqliteBusyTimeoutMs: 5000,
  logFilePath: "logs/diag.jsonl",
};

function parsePositiveIntegerEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const logFilePath = "DIAG_LOG_PATH" in env ? (env.DIAG_LOG_PATH || null) : DEFAULT_CONFIG.logFilePath;
  return {
    port: parsePositiveIntegerEnv(env.PORT, DEFAULT_CONFIG.port),
    host: env.HOST ?? DEFAULT_CONFIG.host,
    dbPath: env.DB_PATH ?? DEFAULT_CONFIG.dbPath,
    seed: parsePositiveIntegerEnv(env.SEED, DEFAULT_CONFIG.seed),
    lockTimeoutMs: parsePositiveIntegerEnv(env.LOCK_TIMEOUT_MS, DEFAULT_CONFIG.lockTimeoutMs),
    sqliteBusyTimeoutMs: parsePositiveIntegerEnv(env.SQLITE_BUSY_TIMEOUT_MS, DEFAULT_CONFIG.sqliteBusyTimeoutMs),
    logFilePath,
    ...overrides,
  };
}
