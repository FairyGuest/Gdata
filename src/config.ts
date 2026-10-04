import type { ValidatorConfig } from './domain/types.ts';

export interface ServiceConfig extends ValidatorConfig {
  port: number;
  host: string;
  dbPath: string;
}

/** 配置层：集中读取环境变量并给出默认值，供入口/脚本/测试注入 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    port: Number(env.CERTCHAIN_PORT ?? 8787),
    host: env.CERTCHAIN_HOST ?? '127.0.0.1',
    dbPath: env.CERTCHAIN_DB ?? './data/certchain.db',
    renewalWarningDays: Number(env.CERTCHAIN_RENEWAL_WARNING_DAYS ?? 30),
    renewalCriticalDays: Number(env.CERTCHAIN_RENEWAL_CRITICAL_DAYS ?? 7),
    maxChainLength: Number(env.CERTCHAIN_MAX_CHAIN_LENGTH ?? 8),
  };
}
