export interface ServiceConfig {
  port: number;
  host: string;
  dbPath: string;
  maxRuns: number;
  maxCasesPerRun: number;
  maxTotalCases: number;
  logBufferSize: number;
  logToStdout: boolean;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    port: int(env.PORT, 4570),
    host: env.HOST ?? '127.0.0.1',
    dbPath: env.DB_PATH ?? 'data/reports.db',
    maxRuns: int(env.MAX_RUNS, 100),
    maxCasesPerRun: int(env.MAX_CASES_PER_RUN, 10_000),
    maxTotalCases: int(env.MAX_TOTAL_CASES, 50_000),
    logBufferSize: int(env.LOG_BUFFER_SIZE, 500),
    logToStdout: env.LOG_STDOUT !== 'false',
  };
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`invalid integer configuration value: ${value}`);
  }
  return n;
}
