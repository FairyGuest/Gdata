import Fastify, { FastifyInstance, FastifyReply } from 'fastify';
import { AppConfig, loadConfig } from './config.js';
import { Ledger } from './state/ledger.js';
import { LoanKernel, WriteOutcome } from './kernel/kernel.js';
import { DiagnosticService } from './diag/queries.js';
import { parseLoanId, parseWriteCommand } from './contract/parser.js';
import { DomainError, HTTP_STATUS } from './contract/errors.js';

export interface AppContext {
  app: FastifyInstance;
  ledger: Ledger;
  kernel: LoanKernel;
  diag: DiagnosticService;
}

let runCounter = 0;
function nextRunId(): string {
  runCounter += 1;
  return `run-${process.pid}-${runCounter.toString().padStart(5, '0')}`;
}

function sendOutcome(reply: FastifyReply, outcome: WriteOutcome) {
  if (outcome.status === 'ok') {
    reply.code(200).send({ ok: true, ...outcome });
    return;
  }
  reply.code(outcome.httpStatus).send({
    ok: false,
    runId: outcome.runId,
    error: {
      category: 'conflict',
      reason: outcome.reason,
      message: outcome.reason,
      detail: { ...outcome.data, tick: outcome.tick, commitSeq: outcome.commitSeq },
    },
  });
}

function sendDomainOrUnknown(reply: FastifyReply, err: unknown, runId: string) {
  if (err instanceof DomainError) {
    reply.code(HTTP_STATUS[err.category]).send(err.toBody(runId));
    return;
  }
  const e = err as { category?: string; reason?: string; message?: string; code?: string };
  if (e?.category === 'resource' && e?.reason === 'resource_busy') {
    reply.code(503).send({
      ok: false,
      runId,
      error: { category: 'resource', reason: 'resource_busy', message: e.message ?? 'resource busy', detail: {} },
    });
    return;
  }
  reply.code(500).send({
    ok: false,
    runId,
    error: { category: 'computation', reason: 'computation_failed', message: e?.message ?? 'unknown failure', detail: { code: e?.code ?? null } },
  });
}

export function buildApp(cfg: AppConfig = loadConfig(), ledger: Ledger = Ledger.open(cfg)): AppContext {
  const app = Fastify({ logger: false });
  const kernel = new LoanKernel(ledger);
  const diag = new DiagnosticService(ledger);

  app.setErrorHandler((error, request, reply) => {
    void request;
    sendDomainOrUnknown(reply, error, nextRunId());
  });

  app.get('/health', async () => ({ ok: true, tick: ledger.getTick() }));

  app.post('/loans/borrow', async (request, reply) => {
    const cmd = parseWriteCommand('borrow', request.body, nextRunId());
    if (cmd.kind !== 'borrow') throw new Error('unreachable command kind');
    sendOutcome(reply, kernel.borrow(cmd));
  });

  app.post('/loans/:id/repay', async (request, reply) => {
    const id = (request.params as { id: unknown }).id;
    const body = { ...((request.body as Record<string, unknown> | null) ?? {}), loanId: parseLoanId(id) };
    const cmd = parseWriteCommand('repay', body, nextRunId());
    if (cmd.kind !== 'repay') throw new Error('unreachable command kind');
    sendOutcome(reply, kernel.repay(cmd));
  });

  app.post('/loans/:id/liquidate', async (request, reply) => {
    const id = (request.params as { id: unknown }).id;
    const body = { ...((request.body as Record<string, unknown> | null) ?? {}), loanId: parseLoanId(id) };
    const cmd = parseWriteCommand('liquidate', body, nextRunId());
    if (cmd.kind !== 'liquidate') throw new Error('unreachable command kind');
    sendOutcome(reply, kernel.liquidate(cmd));
  });

  app.get('/loans/:id', async (request) => {
    const loanId = parseLoanId((request.params as { id: unknown }).id);
    return { ok: true, loan: diag.loanView(loanId) };
  });

  app.get('/diag/state', async () => ({ ok: true, state: diag.systemState() }));

  return { app, ledger, kernel, diag };
}

export async function startServer(cfg = loadConfig()): Promise<AppContext> {
  const ctx = buildApp(cfg);
  await ctx.app.listen({ host: cfg.host, port: cfg.port });
  return ctx;
}

