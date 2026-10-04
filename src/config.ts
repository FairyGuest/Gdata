export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;
  maxRoles: number;
  maxPolicies: number;
  maxInheritanceDepth: number;
  decisionLogCapacity: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.RBAC_PORT ?? 3000),
    host: env.RBAC_HOST ?? "127.0.0.1",
    dbPath: env.RBAC_DB_PATH ?? "rbac.db",
    maxRoles: Number(env.RBAC_MAX_ROLES ?? 1000),
    maxPolicies: Number(env.RBAC_MAX_POLICIES ?? 5000),
    maxInheritanceDepth: Number(env.RBAC_MAX_DEPTH ?? 32),
    decisionLogCapacity: Number(env.RBAC_DECISION_LOG_CAPACITY ?? 200),
  };
}

