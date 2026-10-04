export interface AppConfig {
  port: number;
  dbPath: string;
  runId: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 8080);
  const dbPath = env.DB_PATH ?? "data/indexer.sqlite";
  const runId = env.RUN_ID ?? `local-${new Date(0).toISOString()}`;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid PORT: ${env.PORT}`);
  }
  return { port, dbPath, runId };
}

