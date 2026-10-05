/** 本地演示：启动真实 HTTP 服务，跑一次示例测试并打印汇总，然后关闭。 */
import { loadConfig } from '../dist/config.js';
import { buildServer } from '../dist/server.js';
import { RunStore } from '../dist/store.js';

const cfg = loadConfig();
const store = new RunStore(cfg.dbPath);
const app = buildServer(cfg, store);
await app.listen({ port: cfg.port, host: cfg.host });
console.log('服务已启动: http://' + cfg.host + ':' + cfg.port);

const res = await fetch('http://' + cfg.host + ':' + cfg.port + '/runs', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ dir: 'fixtures/sample', timeoutMs: 1500 }),
});
const summary = await res.json();
console.log('运行完成 runId=' + summary.runId + ' 状态=' + summary.status);
for (const r of summary.results) {
  console.log('  [' + r.status + '] ' + r.file + ' :: ' + r.case + ' (' + r.durationMs + 'ms)' + (r.error ? ' - ' + r.error : ''));
}
console.log('汇总: total=' + summary.total + ' passed=' + summary.passed + ' failed=' + summary.failed + ' timeout=' + summary.timeout);
console.log('历史查询: GET http://' + cfg.host + ':' + cfg.port + '/runs?file=pass');

await app.close();
store.close();