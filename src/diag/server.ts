// Diagnostic interface: HTTP API exposing evaluation, replay and run listing.
import Fastify, { type FastifyInstance } from 'fastify';
import { validateEvaluateBody } from '../contract/validate.ts';
import { ServiceError, type ErrorBody, type JsonObject } from '../contract/types.ts';
import { mergeLayers } from '../core/merge.ts';
import { compareDrift } from '../core/drift.ts';
import { RunStore } from '../state/store.ts';

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_INPUT: 400,
  INVALID_LAYER: 422,
  NOT_FOUND: 404,
  STATE_CONFLICT: 409,
  RESOURCE_EXHAUSTED: 413,
  COMPUTATION_FAILURE: 500,
};

export interface ServerOptions {
  dbPath: string;
  logger?: boolean;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const store = new RunStore(options.dbPath);
  const app = Fastify({
    logger: options.logger ?? false,
    // small body limit so oversized payloads surface as RESOURCE_EXHAUSTED
    bodyLimit: 1024 * 1024,
  });

  app.addHook('onClose', async () => store.close());

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ServiceError) {
      const body: ErrorBody = { error: { code: err.code, message: err.message, details: err.details } };
      return reply.status(STATUS_BY_CODE[err.code] ?? 500).send(body);
    }
    const fastifyErr = err as { statusCode?: number; code?: string; message?: string };
    if (fastifyErr.statusCode === 413 || fastifyErr.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      const body: ErrorBody = {
        error: { code: 'RESOURCE_EXHAUSTED', message: 'Request body exceeds 1 MiB limit' },
      };
      return reply.status(413).send(body);
    }
    if (fastifyErr.statusCode === 400) {
      const body: ErrorBody = {
        error: { code: 'INVALID_INPUT', message: fastifyErr.message ?? 'Malformed request' },
      };
      return reply.status(400).send(body);
    }
    const body: ErrorBody = {
      error: { code: 'COMPUTATION_FAILURE', message: fastifyErr.message ?? 'Unexpected failure' },
    };
    return reply.status(500).send(body);
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/api/evaluations', async (req, reply) => {
    const { env, layers, snapshot } = validateEvaluateBody(req.body);
    const { effective, mergeLog } = mergeLayers(layers);
    const drift = compareDrift(effective, snapshot as JsonObject);
    const record = store.saveRun(env, { layers, snapshot }, { effective, drift, mergeLog });
    // structured run log: replayable run id, key intermediate state, verdict reason
    req.log.info(
      {
        runId: record.runId,
        env,
        mergeLog,
        driftCounts: drift.counts,
        verdict: drift.status,
      },
      'evaluation completed',
    );
    return reply.status(201).send({
      runId: record.runId,
      env: record.env,
      createdAt: record.createdAt,
      effective,
      drift,
      mergeLog,
    });
  });

  app.get('/api/runs', async (req) => {
    const { env } = req.query as { env?: string };
    return { runs: store.listRuns(env) };
  });

  app.get('/api/runs/:runId', async (req) => {
    const { runId } = req.params as { runId: string };
    const record = store.getRun(runId);
    // replay: return the stored layered sources and drift result verbatim
    return record;
  });

  return app;
}
