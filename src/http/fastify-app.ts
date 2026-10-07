// Fastify transport adapter. Only loaded when the fastify package resolves;
// src/server.ts falls back to the node:http adapter when it does not.

import Fastify from 'fastify';
import { buildRoutes, errorToResponse } from './routes.ts';
import type { LifecycleEngine } from '../core/engine.ts';
import type { EnvironmentStore } from '../store/sqlite.ts';
import type { ListeningApp } from './node-app.ts';

export async function startFastifyServer(
  engine: LifecycleEngine,
  store: EnvironmentStore,
  runId: string,
  host: string,
  port: number,
): Promise<ListeningApp> {
  const app = Fastify({ logger: false });
  for (const route of buildRoutes(engine, store, runId)) {
    app.route({
      method: route.method,
      url: route.path,
      handler: async (request, reply) => {
        try {
          const response = route.handler({
            params: request.params as Record<string, string>,
            query: request.query as Record<string, string>,
            body: request.body,
          });
          return reply.code(response.status).send(response.body);
        } catch (err) {
          const response = errorToResponse(err);
          return reply.code(response.status).send(response.body);
        }
      },
    });
  }
  await app.listen({ host, port });
  const address = app.server.address();
  return {
    port: typeof address === 'object' && address ? address.port : port,
    close: () => app.close(),
  };
}

