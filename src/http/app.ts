import type { OrchestratorStore } from '../store/db.ts';
import type { AppConfig } from '../config.ts';
import { MiniFastify } from './fallback.ts';
import { registerRoutes, type RouteApp } from './routes.ts';

export interface BuiltApp {
  app: RouteApp;
  driver: 'fastify' | 'mini-fastify-fallback';
  inject(opts: { method: string; url: string; payload?: unknown }): Promise<{ statusCode: number; body: string; json(): unknown }>;
  listen(port: number, host?: string): Promise<void>;
  close(): Promise<void>;
}

export async function buildApp(store: OrchestratorStore, config: AppConfig): Promise<BuiltApp> {
  let fastifyFactory: ((opts: Record<string, unknown>) => unknown) | null = null;
  try {
    const mod = (await import('fastify')) as { default: (opts: Record<string, unknown>) => unknown };
    fastifyFactory = mod.default;
  } catch {
    fastifyFactory = null;
  }

  if (fastifyFactory) {
    const app = fastifyFactory({ logger: false, bodyLimit: config.maxBodyBytes }) as {
      get(p: string, h: unknown): void;
      post(p: string, h: unknown): void;
      put(p: string, h: unknown): void;
      setErrorHandler(h: unknown): void;
      inject(o: { method: string; url: string; payload?: unknown }): Promise<{ statusCode: number; body: string; json(): unknown }>;
      listen(o: { port: number; host: string }): Promise<string>;
      close(): Promise<void>;
    };
    registerRoutes(app as unknown as RouteApp, store, config);
    return {
      app: app as unknown as RouteApp,
      driver: 'fastify',
      inject: (o) => app.inject(o),
      listen: async (port, host) => {
        await app.listen({ port, host: host ?? '127.0.0.1' });
      },
      close: () => app.close(),
    };
  }

  const mini = new MiniFastify(config.maxBodyBytes);
  registerRoutes(mini, store, config);
  return {
    app: mini,
    driver: 'mini-fastify-fallback',
    inject: (o) => mini.inject(o),
    listen: (port, host) => mini.listen({ port, host }),
    close: () => mini.close(),
  };
}
