// Fastify adapter: used when the optional 'fastify' dependency is installed
// (npm install with network access). Registers the same route table and error
// contract as the zero-dependency node:http adapter in server.ts.

import type { LifecycleKernel } from './core/lifecycle.ts';
import type { EnvironmentStore, EnvStatus } from './store/sqliteStore.ts';
import type { VirtualClock } from './clock.ts';
import { errorBody, type HttpApp } from './server.ts';

export async function buildFastifyApp(
  kernel: LifecycleKernel,
  store: EnvironmentStore,
  clock: VirtualClock | null,
): Promise<HttpApp> {
  const { default: Fastify } = await import('fastify');
  const app = Fastify({ logger: false });

  app.setErrorHandler((err: unknown, _req: unknown, reply: { status: (n: number) => { send: (b: unknown) => void } }) => {
    const { status, body } = errorBody(err);
    reply.status(status).send(body);
  });

  const now = () => (clock ? clock.now() : Date.now());

  app.get('/health', () => ({ ok: true, now: now() }));
  app.post('/environments', async (req: { body: unknown }, reply: { status: (n: number) => unknown }) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const outcome = await kernel.create({
      branch: b.branch as string,
      owner: b.owner as string,
      overrides: b.overrides as Record<string, unknown> | undefined,
      ttlSeconds: b.ttlSeconds as number | undefined,
    });
    reply.status(outcome.idempotent ? 200 : 201);
    return { env: outcome.env, idempotent: outcome.idempotent };
  });
  app.post('/environments/:id/renew', async (req: { params: { id: string } }) => ({ env: kernel.renew(req.params.id) }));
  app.delete('/environments/:id', async (req: { params: { id: string }; query: Record<string, string>; body: unknown }) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const env = await kernel.delete(req.params.id, {
      force: req.query.force === 'true' || b.force === true,
      reason: (req.query.reason ?? b.reason) as string | undefined,
      actor: b.actor as string | undefined,
    });
    return { env };
  });
  app.get('/environments/:id', async (req: { params: { id: string } }) => ({ env: kernel.get(req.params.id) }));
  app.get('/environments', async (req: { query: Record<string, string> }) => ({
    environments: kernel.list({ branch: req.query.branch, status: req.query.status as EnvStatus | undefined }),
  }));
  app.get('/environments/:id/transitions', async (req: { params: { id: string } }) => ({ transitions: store.listTransitions(req.params.id) }));
  app.get('/audit', async (req: { query: Record<string, string> }) => ({ audit: store.listAudit(req.query.envId) }));
  app.post('/admin/tick', async (req: { body: unknown }) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (clock && typeof b.advanceSeconds === 'number') clock.advanceSeconds(b.advanceSeconds);
    return { now: now(), ...kernel.tick() };
  });

  return {
    async listen(port: number, host = '127.0.0.1') { await app.listen({ port, host }); },
    async close() { await app.close(); },
    port() {
      const addr = app.server.address();
      return typeof addr === 'object' && addr !== null ? addr.port : 0;
    },
  };
}

export async function fastifyAvailable(): Promise<boolean> {
  try { await import('fastify'); return true; } catch { return false; }
}
