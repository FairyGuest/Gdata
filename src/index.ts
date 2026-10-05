import { loadConfig } from './config.ts';
import { createServer } from './api/server.ts';

const config = loadConfig();
const server = await createServer(config);
console.log(`flaky-detector listening on http://127.0.0.1:${server.port} (db: ${config.dbPath})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void server.close().then(() => process.exit(0));
  });
}
