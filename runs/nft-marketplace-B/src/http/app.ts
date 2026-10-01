import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { MarketError, inputError, isSqliteBusy, isSqliteError } from '../contract/errors.ts';
import { parseAcceptParams, parseCancelParams, parseListParams } from '../contract/parse.ts';
import type { Journal } from '../diag/journal.ts';
import type { MarketEngine } from '../kernel/engine.ts';
import type { Ledger } from '../state/ledger.ts';

export interface AppDeps {
  ledger: Ledger;
  engine: MarketEngine;
  journal: Journal;
  runId: string;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { ledger, engine, journal, runId } = deps;
  let requestCounter = 0;
  const app = Fastify({
    logger: false,
    genReqId: () => 'req-' + runId + '-' + String(++requestCounter),
  });

  app.setErrorHandler((err, req, reply) => {
    const requestId = String(req.id);
    if (err instanceof MarketError) {
      void reply.status(err.httpStatus).send({
        error: {
          category: err.category,
          reason: err.reason,
          message: err.message,
          details: err.details ?? null,
          runId,
          requestId,
        },
      });
      return;
    }
    if (isSqliteError(err)) {
      const reason = isSqliteBusy(err) ? 'lock_timeout' : 'storage_unavailable';
      void reply.status(503).send({
        error: { category: 'resource', reason, message: String(err), runId, requestId },
      });
      return;
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 400) {
      void reply.status(422).send({
        error: { category: 'input', reason: 'invalid_body', message: (err as Error).message, runId, requestId },
      });
      return;
    }
    void reply.status(500).send({
      error: { category: 'internal', reason: 'unexpected', message: String(err), runId, requestId },
    });
  });

  app.post('/orders', async (req, reply) => {
    const params = parseListParams(req.body, ledger);
    const order = engine.list(params, String(req.id));
    return reply.status(201).send({ order, runId, requestId: String(req.id) });
  });

  app.post('/orders/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const params = parseCancelParams(id, req.body);
    const order = engine.cancel(params, String(req.id));
    return { order, runId, requestId: String(req.id) };
  });

  app.post('/orders/:id/accept', async (req) => {
    const { id } = req.params as { id: string };
    const params = parseAcceptParams(id, req.body, ledger);
    const fill = engine.accept(params, String(req.id));
    return { fill, runId, requestId: String(req.id) };
  });

  app.get('/orders/:id', async (req) => {
    const { id } = req.params as { id: string };
    const order = ledger.getOrder(id);
    if (!order) throw inputError('unknown_order', 'unknown order "' + id + '"', { orderId: id });
    return { order, events: journal.eventsFor(id), runId };
  });

  app.get('/collections/:id', async (req) => {
    const { id } = req.params as { id: string };
    const collection = ledger.getCollection(id);
    if (!collection) throw inputError('unknown_collection', 'unknown collection "' + id + '"', { collectionId: id });
    return { collection, runId };
  });

  app.get('/diag/orders/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    return { runId, events: journal.eventsFor(id) };
  });

  app.get('/diag/fills/:orderId', async (req) => {
    const { orderId } = req.params as { orderId: string };
    const fill = ledger.getFill(orderId);
    if (!fill) throw inputError('unknown_order', 'no fill recorded for order "' + orderId + '"', { orderId });
    return { runId, fill };
  });

  app.get('/diag/health', async () => {
    const expected = Number(ledger.getMeta('expected_balance_sum'));
    const actual = ledger.sumBalances();
    return {
      runId,
      expectedBalanceSum: expected,
      actualBalanceSum: actual,
      conserved: actual === expected,
      commitSeq: Number(ledger.getMeta('commit_seq') ?? '0'),
      fills: ledger.countFills(),
    };
  });

  app.get('/state/ledger', async () => ({
    runId,
    users: ledger.listUsers(),
    tokens: ledger.listTokens(),
    orders: ledger.listOrders(),
    collections: ledger.listCollections(),
  }));

  return app;
}
