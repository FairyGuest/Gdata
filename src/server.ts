// Diagnostics API layer (Fastify). Translates AppError codes into HTTP
// statuses; unknown exceptions are never reported as success.
import fastify from 'fastify';
import {
  AppError,
  computationFailure,
  notFound,
  stateConflict,
  type RunLogger,
} from './contracts.ts';
import { parseRunConfig } from './config.ts';
import { runLoadTest } from './engine.ts';
import { RunStore } from './store.ts';

export interface BuildOptions {
  store?: RunStore;
  log?: RunLogger;
}

export function buildApp(opts: BuildOptions = {}) {
  const store = opts.store ?? new RunStore();
  const log: RunLogger =
    opts.log ??
    ((event, fields) => {
      console.log('[run] ' + event + ' ' + JSON.stringify(fields));
    });
  const app = fastify();

  // Only one run at a time: a second POST while a run is active is a
  // state conflict, not a silent queue.
  let activeRun = false;

  app.setErrorHandler((err: unknown, _req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (err instanceof AppError) {
      return reply.code(err.httpStatus).send({ error: { code: err.code, message: err.message } });
    }
    const wrapped = computationFailure(err instanceof Error ? err.message : String(err));
    return reply.code(500).send({ error: { code: wrapped.code, message: wrapped.message } });
  });

  app.post('/runs', async (req: { body: unknown }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    const config = parseRunConfig(req.body);
    if (activeRun) {
      throw stateConflict('another load test run is already in progress');
    }
    activeRun = true;
    try {
      const result = await runLoadTest(config, log);
      const id = store.save(result);
      log('run.persisted', { id });
      return reply.code(201).send({ id, ...result });
    } finally {
      activeRun = false;
    }
  });

  app.get('/runs', async (req: { query: Record<string, string | undefined> }) => {
    const { url, from, to, limit } = req.query ?? {};
    return {
      runs: store.query({
        url,
        from,
        to,
        limit: limit !== undefined ? Number(limit) : undefined,
      }),
    };
  });

  app.get('/runs/:id', async (req: { params: { id: string } }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw notFound('run not found: ' + req.params.id);
    const row = store.get(id);
    if (!row) throw notFound('run not found: ' + id);
    return { ...row, result: JSON.parse(row.result) };
  });

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
