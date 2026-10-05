import { MockEngine } from './core/engine.ts';
import { RequestRecorder } from './state/recorder.ts';
import { loadRoutesFromFile } from './config/loader.ts';
import { startMockServer } from './adapters/http.ts';
import { MockError } from './contracts/errors.ts';

/** 服务入口：组合 配置层 -> 内核 -> 状态层 -> 适配层。 */
async function main(): Promise<void> {
  const configPath = process.env.MOCK_CONFIG ?? 'config/routes.demo.json';
  const port = Number(process.env.PORT ?? 8080);
  const dbFile = process.env.MOCK_DB; // 缺省内存库

  const routes = loadRoutesFromFile(configPath);
  const engine = new MockEngine(routes);
  const recorder = new RequestRecorder({ file: dbFile });
  const handle = await startMockServer({ engine, recorder, port });

  console.log(`[mock-server] 已加载 ${routes.length} 条路由，监听 http://127.0.0.1:${handle.port}`);
  console.log('[mock-server] 诊断接口: /__health /__routes /__requests /__requests/count /__verify /__reset');

  const shutdown = async () => {
    await handle.close();
    recorder.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  if (err instanceof MockError) {
    console.error(`[mock-server] 启动失败 [${err.category}/${err.code}]: ${err.message}`);
  } else {
    console.error('[mock-server] 启动失败 [COMPUTATION_FAILURE]:', err);
  }
  process.exit(1);
});
