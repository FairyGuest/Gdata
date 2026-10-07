// Diagnostic interface: HTTP contract parser. Translates requests into
// kernel calls and kernel errors into the wire error contract. No business
// rules live here.
import Fastify, { FastifyInstance } from 'fastify';
import { ServiceError } from '../contracts/types.js';
import { SecretService } from '../core/service.js';
import { Logger } from '../logging.js';

interface SecretParams { org: string; project?: string; env?: string; name: string }
interface EnvParams { org: string; project: string; env: string }

export function buildServer(service: SecretService, logger: Logger): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ServiceError) {
      logger.warn('request.rejected', {
        requestId: req.id,
        category: err.category,
        code: err.code,
        reason: err.message,
        details: err.details,
      });
      return reply.status(err.httpStatus).send(err.toJSON());
    }
    logger.error('request.failed', {
      requestId: req.id,
      category: 'INTERNAL_FAILURE',
      reason: (err as Error).message,
      stack: (err as Error).stack,
    });
    return reply.status(500).send({
      error: {
        category: 'INTERNAL_FAILURE',
        code: 'UNEXPECTED',
        message: 'unexpected internal failure',
        details: {},
      },
    });
  });

  app.addHook('onResponse', (req, reply, done) => {
    logger.info('request.completed', {
      requestId: req.id,
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      responseTimeMs: reply.elapsedTime.toFixed(1),
    });
    done();
  });

  app.get('/healthz', () => ({ status: 'ok', runId: logger.runId }));

  app.get('/diagnostics', () => ({ runId: logger.runId, uptimeSec: process.uptime() }));

  const declareHandler = (level: 'org' | 'project' | 'env') => (req: any) => {
    const p = req.params as SecretParams;
    const body = (req.body ?? {}) as { value?: unknown };
    const d = service.upsertDeclaration(
      { level, org: p.org, project: p.project, env: p.env },
      p.name,
      body.value,
    );
    return {
      name: d.name,
      scopePath: `org:${d.org}${d.project ? '/project:' + d.project : ''}${d.env ? '/env:' + d.env : ''}`,
      version: d.version,
      updatedAt: d.updatedAt,
    };
  };

  const deleteHandler = (level: 'org' | 'project' | 'env') => (req: any) => {
    const p = req.params as SecretParams;
    return service.deleteDeclaration({ level, org: p.org, project: p.project, env: p.env }, p.name);
  };

  app.put('/orgs/:org/secrets/:name', declareHandler('org'));
  app.delete('/orgs/:org/secrets/:name', deleteHandler('org'));
  app.put('/orgs/:org/projects/:project/secrets/:name', declareHandler('project'));
  app.delete('/orgs/:org/projects/:project/secrets/:name', deleteHandler('project'));
  app.put('/orgs/:org/projects/:project/environments/:env/secrets/:name', declareHandler('env'));
  app.delete('/orgs/:org/projects/:project/environments/:env/secrets/:name', deleteHandler('env'));

  app.post('/orgs/:org/projects/:project/environments', (req, reply) => {
    const p = req.params as { org: string; project: string };
    const body = (req.body ?? {}) as { env?: unknown; required?: unknown };
    const result = service.createEnvironment({
      org: p.org,
      project: p.project,
      env: body.env as string,
      required: body.required as string[],
    });
    return reply.status(201).send(result);
  });

  app.get('/orgs/:org/projects/:project/environments/:env/secrets', (req) => {
    const p = req.params as EnvParams;
    return service.listEnvironmentSecrets(p.org, p.project, p.env);
  });

  app.delete('/orgs/:org/projects/:project/environments/:env', (req) => {
    const p = req.params as EnvParams;
    return service.deleteEnvironment(p.org, p.project, p.env);
  });

  app.get('/bindings', (req) => {
    const q = req.query as { environmentId?: string; name?: string };
    return { bindings: service.queryBindings({ environmentId: q.environmentId, name: q.name }) };
  });

  return app;
}

