// Runnable service entrypoint.
import { loadConfig } from './config.js';
import { createLogger } from './logging.js';
import { SecretStore } from './state/store.js';
import { SecretService } from './core/service.js';
import { buildServer } from './http/server.js';

const config = loadConfig();
const logger = createLogger(config.logFile);
const store = new SecretStore(config.dbPath);
const service = new SecretService(store, config, logger);
const app = buildServer(service, logger);

app.listen({ host: config.host, port: config.port }).then((addr) => {
  logger.info('server.listening', { addr, runId: logger.runId, dbPath: config.dbPath });
  console.log(`env-secrets-binding listening at ${addr} (runId ${logger.runId})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.close().then(() => {
      store.close();
      process.exit(0);
    });
  });
}
