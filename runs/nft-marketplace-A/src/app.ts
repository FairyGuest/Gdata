import Fastify, { FastifyInstance } from 'fastify';
import { AppConfig, loadConfig } from './config.js';
import { DiagLogger } from './diag/logger.js';
import { createFileSink } from './diag/file-sink.js';
import { registerDiagRoutes, DiagRecorder } from './diag/recorder.js';
import { AdminService } from './kernel/admin-service.js';
import { MarketService } from './kernel/market-service.js';
import { registerMarketRoutes } from './routes/market-routes.js';
import { SqliteLedger } from './state/sqlite-ledger.js';

export interface BuiltApp {
  app: FastifyInstance;
  ledger: SqliteLedger;
  close: () => Promise<void>;
}

export async function buildApp(config: AppConfig = loadConfig()): Promise<BuiltApp> {
  const app = Fastify({ logger: false });
  const ledger = new SqliteLedger(config.dbPath, config.lockWaitMs);
  const service = new MarketService(ledger);
  const admin = new AdminService(ledger);
  const sink = config.diagLogPath ? createFileSink(config.diagLogPath) : null;
  const diag = new DiagLogger(sink, config.diagConsole);
  const recorder = new DiagRecorder(diag);

  await registerMarketRoutes(app, { ledger, service, admin, recorder });
  registerDiagRoutes(app, diag);

  return {
    app,
    ledger,
    close: async () => {
      await app.close();
      ledger.close();
    },
  };
}
