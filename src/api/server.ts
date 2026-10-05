// Diagnostic HTTP interface. Thin layer: validates envelopes, delegates to
// engine/store, and maps the error contract to HTTP statuses.
import fastify, { type FastifyInstance } from 'fastify';
import type { EngineConfig, SourceFile } from '../contracts/types.ts';
import { EngineError, toEngineError } from '../contracts/errors.ts';
import { RunLogger } from '../contracts/logger.ts';
import { LintEngine } from '../core/engine.ts';
import { LintStore } from '../state/store.ts';

export interface AppDeps {
  config: EngineConfig;
  store: LintStore;
}

export function buildApp({ config, store }: AppDeps): FastifyInstance {
  const app = fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    const e = toEngineError(err);
    reply.code(e.httpStatus).send({ error: { category: e.category, message: e.message, detail: e.detail ?? null } });
  });

  app.get('/health', () => ({ status: 'ok', ts: new Date().toISOString() }));

  // ---- rules ----
  app.get('/rules', () => ({ rules: store.listRules() }));

  app.put('/rules', (req) => {
    const body = req.body as { rules?: unknown[] } | unknown[];
    const rules = Array.isArray(body) ? body : body?.rules;
    if (!Array.isArray(rules)) throw new EngineError('INPUT_ERROR', 'body must be an array or { rules: [...] }');
    return { rules: store.replaceRules(rules) };
  });

  app.post('/rules', (req, reply) => {
    const rule = store.addRule(req.body);
    reply.code(201).send({ rule });
  });

  app.patch('/rules/:name', (req) => {
    const body = (req.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      throw new EngineError('INPUT_ERROR', 'body must be { enabled: boolean }');
    }
    return { rule: store.setRuleEnabled(req.params.name, body.enabled) };
  });

  app.delete('/rules/:name', (req, reply) => {
    store.deleteRule(req.params.name);
    reply.code(204).send();
  });

  // ---- checks ----
  app.post('/check', (req) => {
    const body = (req.body ?? {}) as { files?: SourceFile[]; persist?: boolean; rules?: unknown[] };
    if (!Array.isArray(body.files)) throw new EngineError('INPUT_ERROR', 'body.files must be an array of { path, content }');
    const rules = body.rules !== undefined
      ? (body.rules as never[])
      : store.listRules();
    const persist = body.persist !== false;
    const runRef = 'pending-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const logger = new RunLogger(config.logDir, runRef);
    const engine = new LintEngine({ limits: config.limits, logger });
    const result = engine.check(body.files, rules as never[], null);
    let runId: number | null = null;
    if (persist) {
      runId = store.saveRun(result.filesChecked, result.violations);
      logger.log('run.persisted', `runId=${runId} violations=${result.violations.length}`);
    }
    return { ...result, runId, runRef };
  });

  // ---- history ----
  app.get('/runs', () => ({ runs: store.listRuns() }));

  app.get('/runs/:id', (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new EngineError('INPUT_ERROR', `invalid run id "${req.params.id}"`);
    return store.getRun(id);
  });

  app.get('/diff', (req) => {
    const from = Number(req.query.from);
    const to = Number(req.query.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new EngineError('INPUT_ERROR', 'query params from and to must be integer run ids');
    }
    return store.diffRuns(from, to);
  });

  return app;
}
