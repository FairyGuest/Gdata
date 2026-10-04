export interface ServiceConfig {
  port: number;
  host: string;
  // Master secret for the simulated CA keys (fixtures only, never production).
  masterSecret: string;
  // Subjects of roots the verifier trusts.
  trustedRoots: string[];
  // Renewal policy thresholds (days of remaining validity).
  renewSoonDays: number;
  renewImmediatelyDays: number;
  // Resource guard: maximum accepted chain length.
  maxChainLength: number;
  // SQLite file path; ':memory:' for ephemeral runs.
  dbPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    port: Number(env.CERTCHAIN_PORT ?? 8787),
    host: env.CERTCHAIN_HOST ?? '127.0.0.1',
    masterSecret: env.CERTCHAIN_MASTER_SECRET ?? 'local-dev-master-secret',
    trustedRoots: (env.CERTCHAIN_TRUSTED_ROOTS ?? 'CN=Demo Root CA')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    renewSoonDays: Number(env.CERTCHAIN_RENEW_SOON_DAYS ?? 30),
    renewImmediatelyDays: Number(env.CERTCHAIN_RENEW_IMMEDIATELY_DAYS ?? 7),
    maxChainLength: Number(env.CERTCHAIN_MAX_CHAIN_LENGTH ?? 8),
    dbPath: env.CERTCHAIN_DB_PATH ?? 'certchain.db',
  };
}

