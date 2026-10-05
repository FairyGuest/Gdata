// Configuration layer: single source of defaults, overridable via env vars.
export interface ServiceConfig {
  readonly host: string;
  readonly port: number;
  readonly dbPath: string;          // SQLite file, ':memory:' allowed
  readonly defaultTestCommand: string;
  readonly defaultTimeoutMs: number; // per-mutant test timeout
  readonly maxMutantsPerRun: number; // resource guard
  readonly outputTailChars: number;  // test output kept per mutant
  readonly executor: 'spawn' | 'inprocess'; // test execution strategy
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    host: env.MTS_HOST ?? '127.0.0.1',
    port: Number(env.MTS_PORT ?? 4737),
    dbPath: env.MTS_DB ?? 'mutation-history.db',
    defaultTestCommand: env.MTS_TEST_CMD ?? 'node --test test/',
    defaultTimeoutMs: Number(env.MTS_TIMEOUT_MS ?? 20000),
    maxMutantsPerRun: Number(env.MTS_MAX_MUTANTS ?? 500),
    outputTailChars: Number(env.MTS_OUTPUT_TAIL ?? 2000),
    executor: (env.MTS_EXECUTOR === 'inprocess' ? 'inprocess' : 'spawn'),
  };
}

