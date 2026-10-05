import { configFromEnv } from './config.js';
import { RingLogger } from './diag/logger.js';
import { ReportStore } from './store/reportStore.js';
import { buildServer } from './http/server.js';

const config = configFromEnv();
const logger = new RingLogger(config.logBufferSize, config.logToStdout);
const store = new ReportStore(config.dbPath, config.maxRuns);
const app = buildServer({ config, store, logger });

const shutdown = async () => {
  logger.info('shutting down');
  await app.close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

app.listen({ port: config.port, host: config.host }).then((address) => {
  logger.info('listening on ' + address);
}).catch((error) => {
  logger.error('failed to start', { error: String(error) });
  process.exit(1);
});
