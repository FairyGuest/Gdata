// Configuration layer: all tunables in one place, overridable via env.
export interface ScannerConfig {
  port: number;
  host: string;
  dbPath: string;
  vulnDbPath: string;
  maxPackages: number;   // resource guard: total nodes in dependency graph
  maxDepth: number;      // resource guard: max dependency chain depth
}

export function loadConfig(overrides: Partial<ScannerConfig> = {}): ScannerConfig {
  const env = process.env;
  return {
    port: Number(env.SBOM_PORT ?? 3000),
    host: env.SBOM_HOST ?? '127.0.0.1',
    dbPath: env.SBOM_DB_PATH ?? 'data/sbom.db',
    vulnDbPath: env.SBOM_VULN_DB ?? 'fixtures/vuln-db.json',
    maxPackages: Number(env.SBOM_MAX_PACKAGES ?? 10000),
    maxDepth: Number(env.SBOM_MAX_DEPTH ?? 64),
    ...overrides,
  };
}
