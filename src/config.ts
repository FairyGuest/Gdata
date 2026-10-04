
export interface ServiceConfig {
  codeTtlSec: number;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  dbPath: string;
  port: number;
  host: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    codeTtlSec: Number(env.OAUTH_CODE_TTL_SEC ?? 60),
    accessTokenTtlSec: Number(env.OAUTH_ACCESS_TOKEN_TTL_SEC ?? 300),
    refreshTokenTtlSec: Number(env.OAUTH_REFRESH_TOKEN_TTL_SEC ?? 3600),
    dbPath: env.OAUTH_DB_PATH ?? "oauth2.db",
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? "127.0.0.1",
  };
}

export interface ClientRegistration {
  clientId: string;
  redirectUris: string[];
}

export const CLIENT_FIXTURES: ClientRegistration[] = [
  { clientId: "demo-client", redirectUris: ["http://localhost:8080/callback"] },
];
