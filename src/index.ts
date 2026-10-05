import { loadConfig } from './config';
import { buildServer } from './server';
import { RunStore } from './store';

/** 服务入口 */
async function main(): Promise<void> {
  const cfg = loadConfig(process.argv[2]);
  const store = new RunStore(cfg.dbPath);
  const app = buildServer(cfg, store);
  await app.listen({ port: cfg.port, host: cfg.host });
  console.log('test-runner 服务已启动: http://' + cfg.host + ':' + cfg.port);
  console.log('SQLite 数据库: ' + cfg.dbPath);
  const shutdown = async () => {
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});