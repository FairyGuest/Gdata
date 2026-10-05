import Fastify, { type FastifyInstance } from 'fastify';
import { AppError, ContractError, NotFoundError } from '../errors.js';
import { parseIngestRequest } from '../adapter/ingest.js';
import { mergeCases, summarize } from '../kernel/aggregate.js';
import { diffReports } from '../kernel/diff.js';
import { filterSortCases, parseCaseQuery } from '../kernel/query.js';
import type { ReportStore } from '../store/reportStore.js';
import type { RingLogger } from '../diag/logger.js';
import type { ServiceConfig } from '../config.js';

export interface ServerDeps {
  config: ServiceConfig;
  store: ReportStore;
  logger: RingLogger;
}

function parseId(raw: string, field: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ContractError('INVALID_QUERY', 'invalid id: ' + raw, { field });
  }
  return id;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { config, store, logger } = deps;
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      logger.warn(error.message, { code: error.code });
      void reply.status(error.httpStatus).send({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    const err = error as { message?: string; statusCode?: number };
    if (err.statusCode === 400) {
      logger.warn('malformed request', { error: err.message });
      void reply.status(400).send({ error: { code: 'INVALID_PAYLOAD', message: err.message ?? 'bad request' } });
      return;
    }
    if (err.statusCode === 413) {
      void reply.status(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: err.message ?? 'payload too large' } });
      return;
    }
    logger.error('unhandled error', { error: String(error) });
    void reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/diag/logs', async (request) => {
    const query = request.query as { limit?: string };
    const limit = query.limit === undefined ? undefined : parseId(query.limit, 'limit');
    return { entries: logger.recent(limit) };
  });

  app.post('/reports', async (request, reply) => {
    const { label, cases: raw } = parseIngestRequest(request.body);
    const cases = mergeCases(raw, { maxCasesPerRun: config.maxCasesPerRun, maxTotalCases: config.maxTotalCases });
    const summary = summarize(cases);
    const report = store.insertReport(label, summary, cases);
    logger.info('ingested report ' + report.id, { total: summary.total, failed: summary.failed });
    void reply.status(201).send({ id: report.id, createdAt: report.createdAt, summary });
  });

  app.get('/reports', async () => ({ reports: store.listReports() }));

  app.get('/reports/:id', async (request) => {
    const { id: rawId } = request.params as { id: string };
    const report = store.getReport(parseId(rawId, 'id'));
    if (!report) throw new NotFoundError('report not found: ' + rawId);
    const query = parseCaseQuery(request.query as Record<string, string | undefined>);
    return { ...report, cases: filterSortCases(report.cases, query) };
  });

  app.get('/reports/:id/diff', async (request) => {
    const { id: rawId } = request.params as { id: string };
    const query = request.query as { base?: string };
    if (query.base === undefined) {
      throw new ContractError('INVALID_QUERY', 'missing required query parameter: base', { field: 'base' });
    }
    const headId = parseId(rawId, 'id');
    const baseId = parseId(query.base, 'base');
    const head = store.getReport(headId);
    if (!head) throw new NotFoundError('report not found: ' + headId);
    const base = store.getReport(baseId);
    if (!base) throw new NotFoundError('report not found: ' + baseId);
    return diffReports(base, head);
  });

  return app;
}



