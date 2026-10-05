export interface ServiceConfig {
  port: number;
  dbPath: string;
  maxRuns: number;
  maxTestsPerSuite: number;
  passTarget: number;
  maxSuggestedRetries: number;
  cmdTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    port: intFrom(env.FLAKY_PORT, 8080),
    dbPath: env.FLAKY_DB_PATH ?? 'data/flaky.db',
    maxRuns: intFrom(env.FLAKY_MAX_RUNS, 50),
    maxTestsPerSuite: intFrom(env.FLAKY_MAX_TESTS, 200),
    passTarget: floatFrom(env.FLAKY_PASS_TARGET, 0.99),
    maxSuggestedRetries: intFrom(env.FLAKY_MAX_RETRIES, 10),
    cmdTimeoutMs: intFrom(env.FLAKY_CMD_TIMEOUT_MS, 30_000),
  };
}

function intFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('invalid integer config value: ' + raw);
  }
  return n;
}

function floatFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) {
    throw new Error('invalid probability config value: ' + raw);
  }
  return n;
}
