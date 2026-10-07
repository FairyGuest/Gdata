/** Diagnostics HTTP API (Fastify). */

import Fastify, { type FastifyInstance } from 'fastify';
import { ServiceError } from '../domain/errors.ts';
import type { BuildService } from '../service/buildService.ts';

export function buildApp(service: BuildService): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ServiceError) {
      return reply.status(err.httpStatus).send({
        error: { code: err.code, message: err.message, details: err.details ?? null },
      });
    }
    // Unknown failures are computation errors, never silently "ok".
    return reply.status(500).send({
      error: { code: 'COMPUTATION_ERROR', message: String(err), details: null },
    });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/targets', async (req) => {
    const body = (req.body ?? {}) as { targets?: unknown };
    const result = service.registerTargets(body.targets as never);
    return { ok: true, ...result };
  });

  app.post('/events', async (req) => {
    const body = (req.body ?? {}) as { paths?: unknown };
    const result = service.submitEvents(body.paths as never);
    return { ok: true, ...result };
  });

  app.get('/runs/:runId', async (req) => {
    const { runId } = req.params as { runId: string };
    return service.getRun(Number(runId));
  });

  /** Waits for the run to finish, then returns it (used by tests/accept). */
  app.get('/runs/:runId/wait', async (req) => {
    const { runId } = req.params as { runId: string };
    return service.waitForRun(Number(runId));
  });

  app.get('/state', async () => ({ targets: service.getState() }));

  app.get('/targets/:name', async (req) => {
    const { name } = req.params as { name: string };
    return service.getTarget(name);
  });

  return app;
}