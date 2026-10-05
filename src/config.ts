// Configuration layer: env overrides over defaults. Tests construct their own.

export interface ServiceConfig {
  port: number;
  host: string;
  dbPath: string;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  defaultTestCommand: string;
  workspaceRoot: string;
}

export const DEFAULT_CONFIG: ServiceConfig = {
  port: 4319,
  host: '127.0.0.1',
  dbPath: './data/mutation.db',
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 60_000,
  defaultTestCommand: 'node --test --test-isolation=none',
  workspaceRoot: '', // empty => os.tmpdir()/mutation-testing-workspaces
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): ServiceConfig => ({
  port: Number(env.MUTATION_PORT ?? DEFAULT_CONFIG.port),
  host: env.MUTATION_HOST ?? DEFAULT_CONFIG.host,
  dbPath: env.MUTATION_DB ?? DEFAULT_CONFIG.dbPath,
  defaultTimeoutMs: Number(env.MUTATION_TIMEOUT_MS ?? DEFAULT_CONFIG.defaultTimeoutMs),
  maxTimeoutMs: Number(env.MUTATION_MAX_TIMEOUT_MS ?? DEFAULT_CONFIG.maxTimeoutMs),
  defaultTestCommand: env.MUTATION_TEST_COMMAND ?? DEFAULT_CONFIG.defaultTestCommand,
  workspaceRoot: env.MUTATION_WORKSPACE_ROOT ?? DEFAULT_CONFIG.workspaceRoot,
});
