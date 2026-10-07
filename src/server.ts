/** Runnable service entry point. */

import { loadConfig } from './config.ts';
import { BuildService } from './service/buildService.ts';
import { buildApp } from './http/app.ts';

const config = loadConfig();
const service = new BuildService(config);
const app = buildApp(service);

app.listen({ port: config.port, host: config.host }).then(() => {
  console.log(`build-watcher listening on http://${config.host}:${config.port}`);
  console.log(`workspace: ${config.workspaceRoot}`);
  console.log(`db: ${config.dbPath}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void app.close().then(() => { service.close(); process.exit(0); });
  });
}