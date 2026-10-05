import { FastifyInstance } from 'fastify';
import { toErrorBody } from '../contracts/errors';
import { parseStartInjection } from '../contracts/parse';
import { ChaosEngine } from '../kernel/engine';
import { ChaosStore } from '../state/store';

export interface DiagnosticsContext {
  engine: ChaosEngine;
  store: ChaosStore;
  maxDelayMs: number;
  startedAt: number;
}

/** Diagnostics / control API. All errors map to the shared error contract. */
export function registerDiagnostics(app: FastifyInstance, ctx: DiagnosticsContext): void {
  app.get('/chaos/health', async () => ({
    status: 'ok',
    uptimeMs: Date.now() - ctx.startedAt,
    activeInjections: ctx.store.countActive(),
  }));

  app.post('/chaos/injections', async (request, reply) => {
    try {
      const input = parseStartInjection(request.body, { maxDelayMs: ctx.maxDelayMs });
      const session = ctx.engine.start(input);
      return reply.code(201).send({ injection: session });
    } catch (err) {
      const { status, body } = toErrorBody(err);
      return reply.code(status).send(body);
    }
  });

  app.get('/chaos/injections', async () => ({ injections: ctx.engine.list() }));

  app.get('/chaos/injections/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = ctx.store.getInjection(id);
    if (!session) {
      return reply.code(404).send({
        error: { category: 'state_conflict', message: 'injection not found', details: { sessionId: id } },
      });
    }
    return { injection: session };
  });

  app.post('/chaos/injections/:id/stop', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = ctx.engine.stop(id);
      return { injection: session };
    } catch (err) {
      const { status, body } = toErrorBody(err);
      return reply.code(status).send(body);
    }
  });

  app.post('/chaos/stop-all', async () => ({ stopped: ctx.engine.stopAll() }));

  app.get('/chaos/injections/:id/stats', async (request, reply) => {
    const { id } = request.params as { id: string };
    const stats = ctx.store.statsForSession(id);
    if (!stats) {
      return reply.code(404).send({
        error: { category: 'state_conflict', message: 'injection not found', details: { sessionId: id } },
      });
    }
    return { stats };
  });

  app.get('/chaos/injections/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ctx.store.getInjection(id)) {
      return reply.code(404).send({
        error: { category: 'state_conflict', message: 'injection not found', details: { sessionId: id } },
      });
    }
    return { events: ctx.store.eventsForSession(id) };
  });
}