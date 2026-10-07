import Fastify, { type FastifyInstance } from 'fastify';
import { Store } from './state/store.ts';
import { registerRoutes } from './diag/routes.ts';
import { registerErrorHandler } from './diag/error-handler.ts';

export interface BuildOptions {
  dbPath?: string;
  bodyLimit?: number;
  logger?: boolean;
}

export function buildServer(opts: BuildOptions = {}): { app: FastifyInstance; store: Store } {
  const store = new Store(opts.dbPath ?? ':memory:');
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: opts.bodyLimit ?? 1024 * 1024,
  });
  registerErrorHandler(app);
  registerRoutes(app, { store });
  app.addHook('onClose', async () => store.close());
  return { app, store };
}
