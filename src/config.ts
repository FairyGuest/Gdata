/** 配置层：从环境变量解析，带默认值，便于测试与验收脚本注入。 */
export interface ServiceConfig {
  port: number;
  host: string;
  dbPath: string;
  clockMode: 'system' | 'virtual';
  gracePeriodMs: number;
  logCapacity: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '127.0.0.1',
    dbPath: env.DB_PATH ?? ':memory:',
    clockMode: env.CLOCK === 'virtual' ? 'virtual' : 'system',
    gracePeriodMs: Number(env.GRACE_PERIOD_MS ?? 60_000),
    logCapacity: Number(env.LOG_CAPACITY ?? 1000),
  };
}

