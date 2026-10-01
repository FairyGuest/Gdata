import { FastifyInstance } from 'fastify';
import {
  parseAcceptOrder,
  parseCancelOrder,
  parseCreateListing,
} from '../contract/requests.js';
import { requireNonEmptyString, validateBps } from '../contract/primitives.js';
import { AdminService } from '../kernel/admin-service.js';
import { MarketService } from '../kernel/market-service.js';
import { SqliteLedger } from '../state/sqlite-ledger.js';
import { DiagRecorder } from '../diag/recorder.js';
import { assertRoyaltyConservation } from '../kernel/invariants.js';
import { ErrorReason, MarketError } from '../errors.js';

export interface RouteDeps {
  ledger: SqliteLedger;
  service: MarketService;
  admin: AdminService;
  recorder: DiagRecorder;
}

export async function registerMarketRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get('/health', async () => ({
    ok: !deps.ledger.isUnavailable(),
    storage: deps.ledger.isUnavailable() ? 'unavailable' : 'available',
  }));

  app.post('/orders/listings', async (request, reply) => {
    const runId = deps.recorder.begin('list', request.body);
    try {
      const input = parseCreateListing(request.body, deps.ledger);
      const result = await deps.service.createListing(input, { runId });
      deps.recorder.success('list', runId, request.body, result);
      return reply.status(201).send(result);
    } catch (error) {
      const mapped = deps.recorder.failure('list', runId, request.body, error);
      return reply.status(mapped.httpStatus).send(mapped.toBody());
    }
  });

  app.post('/orders/:orderId/cancel', async (request, reply) => {
    const params = request.params as { orderId: string };
    const body = withOrderId(request.body, params.orderId);
    const runId = deps.recorder.begin('cancel', body);
    try {
      const input = parseCancelOrder(body, deps.ledger);
      const result = await deps.service.cancelOrder(input, { runId });
      deps.recorder.success('cancel', runId, body, result);
      return reply.status(200).send(result);
    } catch (error) {
      const mapped = deps.recorder.failure('cancel', runId, body, error);
      return reply.status(mapped.httpStatus).send(mapped.toBody());
    }
  });

  app.post('/orders/:orderId/accept', async (request, reply) => {
    const params = request.params as { orderId: string };
    const body = withOrderId(request.body, params.orderId);
    const runId = deps.recorder.begin('accept', body);
    try {
      const input = parseAcceptOrder(body, deps.ledger);
      const result = await deps.service.acceptOrder(input, { runId });
      deps.recorder.success('accept', runId, body, result);
      return reply.status(200).send(result);
    } catch (error) {
      const mapped = deps.recorder.failure('accept', runId, body, error);
      return reply.status(mapped.httpStatus).send(mapped.toBody());
    }
  });

  app.get('/orders', async () => ({ orders: deps.ledger.listOrders() }));
  app.get('/users', async () => ({ users: deps.ledger.listUsers() }));
  app.get('/tokens/:collectionId/:tokenId', async (request) => {
    const params = request.params as { collectionId: string; tokenId: string };
    return { token: deps.ledger.findToken(params.collectionId, params.tokenId) };
  });

  app.post('/admin/collections/:collectionId/royalty', async (request, reply) => {
    const params = request.params as { collectionId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const payload = {
      collectionId: params.collectionId,
      royaltyBps: validateBps(body.royaltyBps, 'royaltyBps'),
      reason: typeof body.reason === 'string' ? body.reason : 'acceptance-config-change',
    };
    const runId = deps.recorder.begin('admin.updateRoyalty', payload);
    try {
      const result = await deps.admin.updateCollectionRoyalty(payload, { runId });
      return reply.status(200).send(result);
    } catch (error) {
      const mapped = deps.recorder.failure('admin.updateRoyalty', runId, payload, error);
      return reply.status(mapped.httpStatus).send(mapped.toBody());
    }
  });

  app.post('/admin/tokens/:collectionId/:tokenId/transfer', async (request, reply) => {
    const params = request.params as { collectionId: string; tokenId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const payload = {
      collectionId: params.collectionId,
      tokenId: params.tokenId,
      from: requireNonEmptyString(body.from, 'from'),
      nextOwner: requireNonEmptyString(body.nextOwner, 'nextOwner'),
      reason: typeof body.reason === 'string' ? body.reason : 'acceptance-owner-move',
    };
    const runId = deps.recorder.begin('admin.transferToken', payload);
    try {
      const result = await deps.admin.transferTokenForTest(payload, { runId });
      return reply.status(200).send(result);
    } catch (error) {
      const mapped = deps.recorder.failure('admin.transferToken', runId, payload, error);
      return reply.status(mapped.httpStatus).send(mapped.toBody());
    }
  });

  app.post('/admin/faults/storage-unavailable', async (request) => {
    const body = (request.body ?? {}) as { unavailable?: boolean };
    deps.ledger.setUnavailable(body.unavailable !== false);
    return { storageUnavailable: deps.ledger.isUnavailable() };
  });

  app.post('/admin/faults/conservation-failure', async (request, reply) => {
    const runId = deps.recorder.begin('admin.conservationFault', request.body);
    try {
      assertRoyaltyConservation({
        grossPrice: 100,
        royaltyBps: 250,
        royaltyAmount: 99,
        sellerProceeds: 1,
      });
      throw new MarketError(
        'computation',
        ErrorReason.Unexpected,
        'Conservation fault injection unexpectedly passed',
      );
    } catch (error) {
      const mapped = deps.recorder.failure('admin.conservationFault', runId, request.body, error);
      return reply.status(mapped.httpStatus).send(mapped.toBody());
    }
  });

  app.get('/diag/commits', async () => ({ commits: deps.ledger.listCommits() }));
  app.get('/diag/transfers', async (request) => {
    const query = request.query as { orderId?: string };
    return { transfers: deps.ledger.listTransfers(query.orderId) };
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof MarketError) {
      return reply.status(error.httpStatus).send(error.toBody());
    }
    const parseFailure = error as { statusCode?: number; message?: string };
    if (parseFailure.statusCode === 400) {
      const inputError = new MarketError(
        'input',
        ErrorReason.BadType,
        'Request body must be valid JSON with the expected object shape',
        { message: parseFailure.message ?? 'invalid request body' },
      );
      const parseRequest = {
        method: request.method,
        url: request.url,
        contentType: request.headers['content-type'] ?? null,
      };
      const runId = deps.recorder.begin('http.parse_error', parseRequest);
      const recorded = deps.recorder.failure('http.parse_error', runId, parseRequest, inputError);
      return reply.status(recorded.httpStatus).send(recorded.toBody());
    }
    const unexpected = error as { message?: string; name?: string };
    const mapped = new MarketError(
      'computation',
      ErrorReason.Unexpected,
      unexpected.message ?? 'Unexpected failure',
      { name: unexpected.name ?? typeof error },
    );
    return reply.status(500).send(mapped.toBody());
  });
}

function withOrderId(raw: unknown, orderId: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { orderId };
  }
  const body = raw as Record<string, unknown>;
  return { ...body, orderId: body.orderId ?? orderId };
}