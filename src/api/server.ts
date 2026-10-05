import type { ServiceConfig } from '../config.ts';
import { HistoryStore } from '../state/store.ts';
import { NodeHttpAdapter } from './http-adapter.ts';
import { registerRoutes } from './routes.ts';

export interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

export async function createServer(config: ServiceConfig, logger: (line: string) => void = console.log): Promise<RunningServer> {
  const store = new HistoryStore(config.dbPath);
  const app = new NodeHttpAdapter();
  registerRoutes(app, { store, config, logger });
  const port = await app.listen(config.port);
  return {
    port,
    close: async () => {
      await app.close();
      store.close();
    },
  };
}
