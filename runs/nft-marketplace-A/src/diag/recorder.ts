import { FastifyInstance } from 'fastify';
import { MarketError, ErrorReason } from '../errors.js';
import { DiagEvent, DiagLogger, SettlementDiag } from './logger.js';
import { AcceptResult, CancellationResult, ListingResult } from '../kernel/market-service.js';

type OperationResult = ListingResult | CancellationResult | AcceptResult;

function settlementOf(result: OperationResult): SettlementDiag | null {
  if (result.kind !== 'order_filled') return null;
  return {
    grossPrice: result.price,
    royaltyBps: result.split.royaltyBps,
    royaltyAmount: result.split.royaltyAmount,
    sellerProceeds: result.split.sellerProceeds,
    royaltyRecipient: result.royaltyRecipient,
    payer: result.buyer,
    payee: result.seller,
  };
}

function transitionOf(result: OperationResult) {
  return result.transition;
}

export class DiagRecorder {
  constructor(private readonly logger: DiagLogger) {}

  begin(action: string, request: unknown): string {
    return this.logger.begin(action, request);
  }

  success(action: string, runId: string, request: unknown, result: OperationResult): DiagEvent {
    const event: DiagEvent = {
      runId,
      action,
      request,
      decision: 'accepted',
      category: null,
      reason: 'ok',
      httpStatus: 200,
      orderId: result.order.id,
      tokenId: result.kind === 'listing_created' ? result.token.id : result.order.tokenId,
      transition: transitionOf(result),
      settlement: settlementOf(result),
      commitSeq: result.commitSeq,
      basis: result.basis,
      recordedAtStep: result.commitSeq,
    };
    return this.logger.record(event);
  }

  failure(action: string, runId: string, request: unknown, caught: unknown): MarketError {
    const error = toMarketError(caught);
    this.logger.record({
      runId,
      action,
      request,
      decision: 'rejected',
      category: error.category,
      reason: error.reason,
      httpStatus: error.httpStatus,
      orderId: error.audit.orderId ?? stringOrNull(error.details.orderId),
      tokenId: error.audit.tokenId ?? stringOrNull(error.details.tokenId),
      transition: error.audit.transition ?? null,
      settlement: null,
      commitSeq: error.audit.commitSeq ?? null,
      basis:
        error.audit.basis ??
        ('rejected: ' + error.message),
      recordedAtStep: 0,
    });
    return error;
  }
}

function toMarketError(error: unknown): MarketError {
  if (error instanceof MarketError) return error;
  return new MarketError(
    'computation',
    ErrorReason.Unexpected,
    error instanceof Error ? error.message : 'Unknown computation failure',
    {
      name: error instanceof Error ? error.name : typeof error,
    },
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function registerDiagRoutes(app: FastifyInstance, logger: DiagLogger): void {
  app.get('/diag/runs', async () => ({
    runs: logger.list(),
  }));
  app.get('/diag/runs/:runId', async (request, reply) => {
    const params = request.params as { runId: string };
    const event = logger.get(params.runId);
    if (!event) {
      return reply.status(404).send({
        error: {
          category: 'input',
          reason: 'input.unknown_run',
          message: 'Unknown diagnostic run id',
          details: { runId: params.runId },
        },
      });
    }
    return { run: event };
  });
}