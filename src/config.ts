// 配置层：集中管理可调参数，支持环境变量覆盖。

export interface ServiceConfig {
  port: number;
  host: string;
  dbPath: string; // ":memory:" 表示内存库
  maxCasesPerReport: number;
  maxRunsPerReport: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    port: Number(env.REPORTER_PORT ?? 8787),
    host: env.REPORTER_HOST ?? "127.0.0.1",
    dbPath: env.REPORTER_DB ?? ":memory:",
    maxCasesPerReport: Number(env.REPORTER_MAX_CASES ?? 100000),
    maxRunsPerReport: Number(env.REPORTER_MAX_RUNS ?? 1000),
  };
}
