import { loadConfig } from './config.ts';
import { CertStore } from './adapters/sqliteStore.ts';
import { buildServer } from './http/server.ts';
import { SystemClock } from './clock/clock.ts';
import { fixtureKeyStore } from './fixtures/caFixtures.ts';

/** 服务入口：组合配置层、状态适配、执行内核与诊断接口 */
async function main(): Promise<void> {
  const config = loadConfig();
  const store = new CertStore(config.dbPath);
  const app = buildServer({ store, clock: new SystemClock(), keyStore: fixtureKeyStore, config });
  await app.listen({ port: config.port, host: config.host });
  console.log('cert-chain-service listening on http://' + config.host + ':' + config.port);
}

main().catch((err) => {
  console.error('服务启动失败:', err);
  process.exit(1);
});
