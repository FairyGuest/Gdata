/** HTTP 层：Fastify 路由，仅做参数校验与错误码映射，业务全在 QuotaService。 */
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ERROR_HTTP_STATUS, toErrorBody } from '../domain/errors.ts';
import type { QuotaService } from '../service/quotaService.ts';
import type { RingLogger } from '../domain/logger.ts';
import type { SqliteStore } from '../store/sqliteStore.ts';

export interface BuildServerOptions {
  service: QuotaService;
  store: SqliteStore;
  logger: RingLogger;
}

function secretOf(req: { headers: Record<string, unknown>; body?: unknown }): string {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header) return header;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body.secret === 'string') return body.secret;
  return '';
}

export function buildServer({ service, store, logger }: BuildServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, req, reply) => {
    const body = toErrorBody(err);
    const status = ERROR_HTTP_STATUS[body.code] ?? 500;
    logger.log('http.error', { code: body.code, status, path: req.url }, body.message, req.id as string);
    reply.status(status).send(body);
  });

  app.get('/health', async () => ({ ok: true, runId: logger.currentRunId }));

  app.post('/scopes', async (req) => {
    const body = req.body as Record<string, unknown>;
    return service.createScope({
      id: String(body.id ?? ''),
      level: body.level as 'global' | 'org' | 'project',
      parentId: (body.parentId ?? null) as string | null,
      quotaLimit: Number(body.quotaLimit),
    });
  });

  app.get('/scopes', async () => store.listScopes());

  app.post('/keys', async (req) => {
    const body = req.body as Record<string, unknown>;
    return service.createKey({
      projectScopeId: String(body.projectScopeId ?? ''),
      id: body.id === undefined ? undefined : String(body.id),
    });
  });

  app.post('/consume', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
    return service.consume(secretOf(req), Number(body.amount ?? 1), requestId);
  });

  app.post('/keys/rotate', async (req) => service.rotate(secretOf(req)));

  app.get('/usage', async (req) => service.usageReport(secretOf(req)));

  app.post('/admin/sweep', async () => ({ expired: service.sweepExpired() }));

  app.get('/logs', async (req) => {
    const q = req.query as Record<string, string>;
    return { runId: logger.currentRunId, entries: logger.recent(Number(q.limit ?? 200)) };
  });

  return app;
}
