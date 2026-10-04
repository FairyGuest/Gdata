// 配置层：集中管理默认值，可用环境变量覆盖。
export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;      // SQLite 文件路径，":memory:" 表示内存库
  logDir: string;      // 诊断日志目录
  maxNodes: number;    // 依赖图节点上限（防资源耗尽）
  maxDepth: number;    // 依赖展开深度上限
  maxPaths: number;    // 每个漏洞包输出的最大路径数
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.SBOM_PORT ?? 8787),
    host: env.SBOM_HOST ?? '127.0.0.1',
    dbPath: env.SBOM_DB_PATH ?? 'data/sbom.sqlite',
    logDir: env.SBOM_LOG_DIR ?? 'logs',
    maxNodes: Number(env.SBOM_MAX_NODES ?? 10000),
    maxDepth: Number(env.SBOM_MAX_DEPTH ?? 100),
    maxPaths: Number(env.SBOM_MAX_PATHS ?? 5),
  };
}
