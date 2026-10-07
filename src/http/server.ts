import { fastify, type FastifyLite } from './fastify-lite.ts';
import { TemplateRegistry } from '../core/registry.ts';
import { Provisioner } from '../core/provisioner.ts';
import { AppError } from '../errors.ts';
import type { InstanceState } from '../state/db.ts';

export interface AppDeps {
  registry: TemplateRegistry;
  provisioner: Provisioner;
}

function errPayload(e: unknown) {
  if (e instanceof AppError) {
    return { status: e.httpStatus, body: { error: { category: e.category, message: e.message, detail: e.detail ?? null } } };
  }
  return { status: 500, body: { error: { category: 'INTERNAL', message: String((e as any)?.message ?? e) } } };
}

function wrap(fn: (req: any) => unknown) {
  return async (req: any, reply: any) => {
    try {
      return await fn(req);
    } catch (e) {
      const { status, body } = errPayload(e);
      reply.status(status);
      return body;
    }
  };
}

export function buildApp(deps: AppDeps): FastifyLite {
  const app = fastify();
  const { registry, provisioner } = deps;

  app.post('/templates', wrap((req) => ({ status: 201, ...registry.register(req.body) })));
  app.get('/templates', wrap(() => registry.list()));
  app.get('/templates/:name', wrap((req) => registry.get(req.params.name)));

  app.post('/templates/:name/provisions', wrap((req) => {
    const template = registry.get(req.params.name);
    const result = provisioner.provision(template, req.body);
    return { status: result.queued ? 202 : 201, ...result };
  }));

  app.get('/environments', wrap((req) => {
    const filter: { template?: string; state?: InstanceState } = {};
    if (req.query.template) filter.template = req.query.template;
    if (req.query.state) filter.state = req.query.state as InstanceState;
    return provisioner.list(filter);
  }));

  app.get('/environments/:name', wrap((req) => provisioner.get(req.params.name)));
  app.get('/environments/:name/history', wrap((req) => provisioner.history(req.params.name)));
  app.post('/environments/:name/resume', wrap((req) => provisioner.resume(req.params.name)));
  app.post('/environments/:name/suspend', wrap((req) => provisioner.suspend(req.params.name)));
  app.delete('/environments/:name', wrap((req) => provisioner.delete(req.params.name)));

  app.get('/diagnostics', wrap(() => provisioner.diagnostics()));

  // Fastify-lite handlers may return {status, ...body}; honor that shape.
  const origInject = app.inject.bind(app);
  const origDispatchRoutes = (app as any).routes as any[];
  for (const r of origDispatchRoutes) {
    const orig = r.handler;
    r.handler = async (req: any, reply: any) => {
      const out = await orig(req, reply);
      if (out && typeof out === 'object' && 'status' in out && typeof out.status === 'number') {
        reply.status(out.status);
        const { status, ...rest } = out as any;
        return rest;
      }
      return out;
    };
  }
  void origInject;

  return app;
}
