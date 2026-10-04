export interface ServiceConfig {
  host: string;
  port: number;
  dbPath: string;
  codeTtlMs: number;
  accessTokenTtlMs: number;
  refreshTokenTtlMs: number;
  maxCodesPerClient: number;
}

export const DEFAULT_CONFIG: ServiceConfig = {
  host: "127.0.0.1",
  port: 4100,
  dbPath: ":memory:",
  codeTtlMs: 60_000,
  accessTokenTtlMs: 300_000,
  refreshTokenTtlMs: 3_600_000,
  maxCodesPerClient: 10_000,
};

export function loadConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  const env = process.env;
  const fromEnv: Partial<ServiceConfig> = {};
  if (env.OAUTH2_HOST) fromEnv.host = env.OAUTH2_HOST;
  if (env.OAUTH2_PORT) fromEnv.port = Number(env.OAUTH2_PORT);
  if (env.OAUTH2_DB_PATH) fromEnv.dbPath = env.OAUTH2_DB_PATH;
  if (env.OAUTH2_CODE_TTL_MS) fromEnv.codeTtlMs = Number(env.OAUTH2_CODE_TTL_MS);
  if (env.OAUTH2_ACCESS_TTL_MS) fromEnv.accessTokenTtlMs = Number(env.OAUTH2_ACCESS_TTL_MS);
  if (env.OAUTH2_REFRESH_TTL_MS) fromEnv.refreshTokenTtlMs = Number(env.OAUTH2_REFRESH_TTL_MS);
  const merged = { ...DEFAULT_CONFIG, ...fromEnv, ...overrides };
  for (const key of ["codeTtlMs", "accessTokenTtlMs", "refreshTokenTtlMs", "port"] as const) {
    if (!Number.isFinite(merged[key]) || merged[key] <= 0) {
      throw new Error("invalid config: " + key + " must be a positive number, got " + merged[key]);
    }
  }
  return merged;
}
