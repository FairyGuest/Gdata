/**
 * Composition root + HTTP adapter. Wires clock/store/log/kernel together
 * and translates between HTTP and the typed kernel contracts. All errors
 * leaving the kernel are ServiceError values; anything unexpected is
 * reported as COMPUTATION_FAILURE, never as success.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Clock } from './clock.ts';
import { SystemClock } from './clock.ts';
import type { ServiceConfig } from './config.ts';
import { parseIssue, parseTokenBody } from './contract.ts';
import { DiagnosticLog } from './diagnostics.ts';
import { ErrorCode, ServiceError, validationError } from './errors.ts';
import { TokenService } from './kernel.ts';
import { TokenStore } from './store.ts';

export interface BuildOptions {
  config: ServiceConfig;
  clock?: Clock;
}

export interface BuiltServer {
  app: FastifyInstance;
  store: TokenStore;
  service: TokenService;
  log: DiagnosticLog;
}

export function buildServer({ config, clock }: BuildOptions): BuiltServer {
  const time: Clock = clock ?? new SystemClock();
  const store = new TokenStore(config.dbPath);
  const log = new DiagnosticLog(config.diagnosticsCapacity);
  const service = new TokenService(store, time, log, {
    secret: config.secret,
    maxActiveTokensPerSubject: config.maxActiveTokensPerSubject,
  });

  const app = Fastify({ logger: false });

  // Run id: caller-supplied (x-run-id) or generated; echoed in responses
  // and attached to every diagnostic event so runs can be replayed.
  app.addHook('onRequest', async (req, reply) => {
    const incoming = req.headers['x-run-id'];
    const runId =
      typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128
        ? incoming
        : randomUUID();
    (req as unknown as { runId: string }).runId = runId;
    reply.header('x-run-id', runId);
  });

  app.setErrorHandler((err, req, reply) => {
    const runId = (req as unknown as { runId?: string }).runId ?? 'unknown';
    if (err instanceof ServiceError) {
      return reply.status(err.httpStatus).send({
        ok: false,
        runId,
        error: { code: err.code, message: err.message, detail: err.detail ?? null },
      });
    }
    // Fastify body-parse failures are input errors, not server faults.
    if ((err as { statusCode?: number }).statusCode === 400) {
      const wrapped = validationError('malformed JSON body', { cause: err.message });
      return reply.status(400).send({
        ok: false,
        runId,
        error: { code: wrapped.code, message: wrapped.message, detail: wrapped.detail ?? null },
      });
    }
    const wrapped = new ServiceError(
      ErrorCode.COMPUTATION_FAILURE,
      'unexpected internal failure: ' + err.message,
      500,
    );
    return reply.status(500).send({
      ok: false,
      runId,
      error: { code: wrapped.code, message: wrapped.message, detail: null },
    });
  });

  const runIdOf = (req: unknown): string => (req as { runId: string }).runId;

  app.post('/tokens', async (req) => {
    const cmd = parseIssue(req.body, config.maxTtlSeconds);
    const issued = service.issue(runIdOf(req), cmd.subject, cmd.scopes, cmd.ttlSeconds);
    return { ok: true, runId: runIdOf(req), ...issued };
  });

  app.post('/tokens/verify', async (req) => {
    const { token } = parseTokenBody(req.body);
    const claims = service.verify(runIdOf(req), token);
    return { ok: true, runId: runIdOf(req), claims };
  });

  app.post('/tokens/refresh', async (req) => {
    const { token } = parseTokenBody(req.body);
    const ttl =
      typeof (req.body as { ttlSeconds?: unknown })?.ttlSeconds === 'number'
        ? (req.body as { ttlSeconds: number }).ttlSeconds
        : config.defaultRefreshTtlSeconds;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > config.maxTtlSeconds) {
      throw validationError('ttlSeconds must be an integer in (0, ' + config.maxTtlSeconds + ']');
    }
    const issued = service.refresh(runIdOf(req), token, ttl);
    return { ok: true, runId: runIdOf(req), ...issued };
  });

  app.post('/tokens/revoke', async (req) => {
    const { token } = parseTokenBody(req.body);
    const result = service.revoke(runIdOf(req), token);
    return { ok: true, runId: runIdOf(req), ...result };
  });

  app.get('/diagnostics/events', async (req) => {
    const runId = (req.query as { runId?: string }).runId;
    return { ok: true, events: log.list(runId) };
  });

  app.get('/diagnostics/tokens/:jti', async (req) => {
    const { jti } = req.params as { jti: string };
    const record = store.get(jti);
    if (!record) {
      throw validationError('no such token: ' + jti);
    }
    return { ok: true, token: record };
  });

  return { app, store, service, log };
}
