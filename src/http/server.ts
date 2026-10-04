import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { ServiceConfig } from '../config.js';
import type { VirtualClock } from '../domain/clock.js';
import { DomainError, type FailureCode, type VerifyResult } from '../domain/types.js';
import { verifyChain } from '../core/verifyChain.js';
import { RunStore } from '../state/runStore.js';

export interface AppDeps {
  config: ServiceConfig;
  clock: VirtualClock;
  store: RunStore;
}

const HTTP_STATUS: Record<FailureCode, number> = {
  INPUT_INVALID: 400,
  CHAIN_LINK_MISMATCH: 422,
  SIGNATURE_INVALID: 422,
  INTERMEDIATE_SELF_SIGNED: 422,
  ROOT_NOT_SELF_SIGNED: 422,
  ROOT_UNTRUSTED: 422,
  CERT_EXPIRED: 422,
  CERT_NOT_YET_VALID: 422,
  CHAIN_TOO_LONG: 413,
  STATE_CONFLICT: 409,
  STATE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const { config, clock, store } = deps;

  app.get('/health', async () => ({ status: 'ok', now: clock.now().toISOString() }));

  app.post('/v1/verify', async (req, reply) => {
    const result: VerifyResult = verifyChain(req.body, clock, {
      masterSecret: config.masterSecret,
      trustedRoots: config.trustedRoots,
      policy: {
        renewSoonDays: config.renewSoonDays,
        renewImmediatelyDays: config.renewImmediatelyDays,
      },
      maxChainLength: config.maxChainLength,
      runId: randomUUID(),
    });
    try {
      store.save(result);
    } catch (err) {
      if (err instanceof DomainError) {
        return reply.status(HTTP_STATUS[err.code]).send({
          ok: false, runId: result.runId, code: err.code, message: (err as Error).message, linkIndex: null, links: [],
        });
      }
      throw err;
    }
    const status = result.ok ? 200 : HTTP_STATUS[result.code];
    return reply.status(status).send(result);
  });

  // Diagnostics: replay a stored run with its per-link trace.
  app.get('/v1/runs/:runId', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const stored = store.get(runId);
    if (!stored) {
      return reply.status(404).send({ ok: false, code: 'NOT_FOUND', message: `no run with id ${runId}` });
    }
    return stored;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(HTTP_STATUS[err.code]).send({ ok: false, code: err.code, message: (err as Error).message });
    }
    // Malformed JSON bodies land here from the Fastify parser.
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const code: FailureCode = status === 400 ? 'INPUT_INVALID' : 'INTERNAL_ERROR';
    return reply.status(status).send({ ok: false, code, message: (err as Error).message });
  });

  return app;
}

