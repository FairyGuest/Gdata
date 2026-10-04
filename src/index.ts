/** 入口：装配配置、时钟、存储、日志与 HTTP 服务。 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.ts';
import { SystemClock, VirtualClock } from './domain/clock.ts';
import { RingLogger } from './domain/logger.ts';
import { SqliteStore } from './store/sqliteStore.ts';
import { QuotaService } from './service/quotaService.ts';
import { buildServer } from './http/server.ts';

const config = loadConfig();
const runId = randomUUID();
const logger = new RingLogger(config.logCapacity, runId);
const clock = config.clockMode === 'virtual' ? new VirtualClock() : new SystemClock();
const store = new SqliteStore(config.dbPath);
const service = new QuotaService({ store, clock, logger, gracePeriodMs: config.gracePeriodMs });
const app = buildServer({ service, store, logger });

logger.log('service.starting', { config: { ...config, dbPath: config.dbPath === ':memory:' ? ':memory:' : '<file>' } }, 'bootstrapping');

const sweepTimer = setInterval(() => service.sweepExpired(), Math.min(config.gracePeriodMs, 1000));
sweepTimer.unref();

app.listen({ port: config.port, host: config.host }).then((addr) => {
  logger.log('service.listening', { addr }, 'ready');
  console.log(
    'api-key-quota-service listening on ' + addr + ' runId=' + runId,
  );
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    logger.log('service.stopping', { signal: sig }, 'shutdown requested');
    app.close().then(() => { store.close(); process.exit(0); });
  });
}
