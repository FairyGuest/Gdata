// API layer: Fastify routes mapping HTTP to the engine, translating the
// shared error taxonomy into status codes. Unknown errors become 500
// COMPUTATION_FAILURE — never a success response.
import fastify from 'fastify';
import { ScanError, toScanError } from '../contract/errors.ts';
import { ScanEngine } from '../core/engine.ts';
import type { Store } from '../state/store.ts';

export function buildServer(engine: ScanEngine, store: Store) {
  const app = fastify({});

  app.get('/health', async () => ({ status: 'ok', vulnerabilities: store.listVulns().length }));

  app.post('/scan', async (req, reply) => {
    try {
      const report = engine.run(req.body);
      return reply.code(200).send(report);
    } catch (err) {
      const e = toScanError(err);
      return reply.code(e.statusCode).send({
        error: { category: e.category, message: e.message, detail: e.detail ?? null },
      });
    }
  });

  app.get('/scan/:runId', async (req, reply) => {
    const row = store.getRun(req.params.runId);
    if (!row) {
      const e = new ScanError('NOT_FOUND', 'Run "' + req.params.runId + '" not found');
      return reply.code(e.statusCode).send({ error: { category: e.category, message: e.message } });
    }
    return reply.code(200).send(JSON.parse(row.report_json));
  });

  // Diagnostics: full replayable log of a run (intermediate states + rationale).
  app.get('/diagnostics/runs/:runId/logs', async (req, reply) => {
    const logs = store.getLogs(req.params.runId);
    if (logs.length === 0) {
      const e = new ScanError('NOT_FOUND', 'No logs for run "' + req.params.runId + '"');
      return reply.code(e.statusCode).send({ error: { category: e.category, message: e.message } });
    }
    return reply.code(200).send({ runId: req.params.runId, events: logs });
  });

  return app;
}
