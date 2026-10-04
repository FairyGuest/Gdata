// HTTP surface (Fastify). Routes only translate HTTP <-> domain; all rules
// live in contract/kernel/state. Error mapping:
//   422 invalid_input       malformed event body / bad rebuild target
//   409 duplicate_event | event_gap | invalid_transition
//   503 resource_exhausted  db full/locked, batch too large
//   500 internal_error      anything else (never silently succeeds)

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractError, parseEvent } from './contract/events.ts';
import { ConflictError, Engine } from './kernel/engine.ts';
import { getAppliedSeq, openDatabase, ResourceError } from './state/db.ts';
import type { DatabaseSync } from 'node:sqlite';
import { registerDiagRoutes } from './diag/routes.ts';

export interface ServerOptions {
  dbPath?: string;
  runId?: string;
  maxBatchSize?: number;
}

const DEFAULT_MAX_BATCH = 1000;

export function buildServer(opts: ServerOptions = {}): FastifyInstance & { db: DatabaseSync } {
  const dbPath = opts.dbPath ?? process.env.DB_PATH ?? ':memory:';
  if (dbPath !== ':memory:') {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const db = openDatabase(dbPath);
  const runId = opts.runId ?? process.env.RUN_ID ?? 'run-' + Date.now().toString(36);
  const maxBatch = opts.maxBatchSize ?? DEFAULT_MAX_BATCH;
  const engine = new Engine(db, runId);

  const app = Fastify({ logger: false }) as unknown as FastifyInstance & { db: DatabaseSync };
  app.db = db;

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ContractError || err instanceof ConflictError || err instanceof ResourceError) {
      return reply.status(err.status).send({ error: { reason: err.reason, detail: err.message } });
    }
    const anyErr = err as { statusCode?: number; code?: string };
    if (anyErr.statusCode === 413 || anyErr.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(503).send({ error: { reason: 'resource_exhausted', detail: 'request body too large' } });
    }
    if (anyErr.statusCode === 400) {
      return reply.status(422).send({ error: { reason: 'invalid_input', detail: (err as Error).message } });
    }
    return reply.status(500).send({ error: { reason: 'internal_error', detail: (err as Error).message } });
  });

  app.post('/events', async (req, reply) => {
    const ev = parseEvent((req.body as Record<string, unknown>)?.event ?? req.body);
    const result = engine.apply(ev);
    return reply.status(200).send({ ok: true, appliedSeq: result.appliedSeq });
  });

  // Batch ingest: each event is applied in its own transaction, in array
  // order. The batch itself always returns 200 with a per-event verdict so
  // out-of-order / duplicate replays can be diagnosed item by item.
  app.post('/events/batch', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const items = body?.events;
    if (!Array.isArray(items)) {
      return reply.status(422).send({ error: { reason: 'invalid_input', detail: 'events must be an array' } });
    }
    if (items.length > maxBatch) {
      return reply.status(503).send({
        error: { reason: 'resource_exhausted', detail: 'batch of ' + items.length + ' exceeds limit ' + maxBatch },
      });
    }
    const results = items.map((item) => {
      try {
        const ev = parseEvent(item);
        const r = engine.apply(ev);
        return { seq: ev.seq, ok: true as const, status: 200, appliedSeq: r.appliedSeq };
      } catch (err) {
        const e = err as { status?: number; reason?: string; message?: string };
        const seq =
          typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).seq === 'number'
            ? ((item as Record<string, unknown>).seq as number)
            : null;
        return {
          seq,
          ok: false as const,
          status: e.status ?? 500,
          reason: e.reason ?? 'internal_error',
          detail: e.message ?? String(err),
        };
      }
    });
    return reply.status(200).send({ results, appliedSeq: getAppliedSeq(db) });
  });

  app.post('/rebuild', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const toSeq = body?.toSeq;
    if (typeof toSeq !== 'number' || !Number.isInteger(toSeq) || toSeq < 0) {
      return reply.status(422).send({ error: { reason: 'invalid_input', detail: 'toSeq must be an integer >= 0' } });
    }
    const result = engine.rebuild(toSeq);
    return reply.status(200).send({ ok: true, appliedSeq: result.appliedSeq });
  });

  registerDiagRoutes(app, db);
  return app;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  const app = buildServer();
  app.listen({ port, host: '127.0.0.1' }).then((addr) => {
    console.log('nft-indexer listening at ' + addr);
  });
}
