// HTTP layer: Fastify routes mapping to kernel ops, with uniform error
// semantics driven by the contract layer (ErrorKind -> HTTP status).
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { Kernel } from './core/kernel.ts';
import { HistoryStore } from './state/store.ts';
import type { OpResult } from './contracts.ts';
import { ERROR_HTTP } from './contracts.ts';
import type { ServiceConfig } from './config.ts';

export interface App {
  app: FastifyInstance;
  kernel: Kernel;
  store: HistoryStore;
}

function respond<T>(res: OpResult<T>, reply: { code: (n: number) => { send: (b: unknown) => unknown } }, okStatus = 200) {
  if (res.ok) return reply.code(okStatus).send({ runId: res.runId, data: res.value, logs: res.logs });
  const status = res.error ? ERROR_HTTP[res.error.kind] : 500;
  return reply.code(status).send({ runId: res.runId, error: res.error, logs: res.logs });
}

export function buildServer(config: ServiceConfig): App {
  const app = Fastify({ logger: false });
  const kernel = new Kernel();
  const store = new HistoryStore(config.dbPath);
  kernel.setSink(store);

  app.post('/nodes', (req, reply) => respond(kernel.addNode(req.body as never), reply, 201));
  app.post('/namespaces', (req, reply) => respond(kernel.addNamespace(req.body as never), reply, 201));
  app.delete('/namespaces/:name', (req, reply) =>
    respond(kernel.deleteNamespace((req.params as { name: string }).name), reply));
  app.post('/workloads', (req, reply) => respond(kernel.placeWorkload(req.body as never), reply, 201));
  app.delete('/workloads/:id', (req, reply) =>
    respond(kernel.deleteWorkload((req.params as { id: string }).id), reply));

  // diagnostics
  app.get('/diag/state', () => kernel.diagnostics());
  app.get('/diag/conservation', () => kernel.conservation());
  app.get('/diag/history', (req) => {
    const q = req.query as { namespace?: string; node?: string };
    return store.history({ namespace: q.namespace, nodeId: q.node });
  });

  app.addHook('onClose', () => { store.close(); });
  return { app, kernel, store };
}

