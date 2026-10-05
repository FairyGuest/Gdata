import { loadConfig } from './config.ts';
import { Store } from './store.ts';
import { createApp } from './server.ts';

const config = loadConfig();
const store = new Store(config.dbPath);
const server = createApp({
  store,
  limits: { maxRuns: config.maxRuns, maxTestsPerSuite: config.maxTestsPerSuite },
  classifyOptions: { passTarget: config.passTarget, maxSuggestedRetries: config.maxSuggestedRetries },
  executorOptions: { cmdTimeoutMs: config.cmdTimeoutMs },
});

server.listen(config.port, () => {
  console.log('flaky-detector listening on http://127.0.0.1:' + config.port + ' (db: ' + config.dbPath + ')');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
