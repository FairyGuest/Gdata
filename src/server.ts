import Fastify, { type FastifyInstance } from 'fastify';
import type { Clock, VirtualClock } from './clock.js';
import { toVaultError, VaultError } from './errors.js';
import type { VaultKernel } from './kernel.js';

export interface ServerDeps {
  kernel: VaultKernel;
  clock: Clock;
  startedAt: number;
}

function runIdOf(req: { headers: Record<string, unknown>; body?: unknown }): string | undefined {
  const h = req.headers['x-run-id'];
  if (typeof h === 'string' && h.length > 0) return h;
  const b = req.body;
  if (b && typeof b === 'object' && typeof (b as Record<string, unknown>).runId === 'string') {
    return (b as Record<string, string>).runId;
  }
  return undefined;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const { kernel } = deps;

  app.setErrorHandler((err, _req, reply) => {
    const ve = toVaultError(err);
    reply.status(ve.httpStatus).send(ve.toJSON());
  });

  app.get('/health', async () => ({
    status: 'ok',
    now: deps.clock.now(),
    uptimeMs: deps.clock.now() - deps.startedAt,
    stats: kernel.stats(),
  }));

  app.put('/secrets/:name', async (req) => {
    const { name } = req.params as { name: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = kernel.write(name, body.value, { runId: runIdOf(req) });
    return { ...result, ok: true };
  });

  app.get('/secrets/:name', async (req) => {
    const { name } = req.params as { name: string };
    const q = req.query as Record<string, unknown>;
    const result = kernel.read(name, q.version, { runId: runIdOf(req) });
    return { ...result, ok: true };
  });

  app.get('/secrets/:name/versions', async (req) => {
    const { name } = req.params as { name: string };
    return { ok: true, name, versions: kernel.listVersions(name) };
  });

  app.post('/secrets/:name/rotate', async (req) => {
    const { name } = req.params as { name: string };
    const result = kernel.rotate(name, { runId: runIdOf(req) });
    return { ...result, ok: true };
  });

  app.get('/audit', async (req) => {
    const q = req.query as Record<string, unknown>;
    const name = typeof q.name === 'string' ? q.name : undefined;
    return { ok: true, entries: kernel.auditLog().list(name) };
  });

  app.get('/audit/verify', async () => ({ ...kernel.auditLog().verify() }));

  // diagnostics: only usable when a VirtualClock is injected
  app.post('/diag/clock/advance', async (req) => {
    const clock = deps.clock as Partial<VirtualClock>;
    if (typeof clock.advance !== 'function') {
      throw new VaultError('CONFLICT', 'clock is not virtual; advance unsupported');
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ms = Number(body.ms);
    if (!Number.isFinite(ms) || ms < 0) {
      throw new VaultError('VALIDATION', 'ms must be a non-negative number');
    }
    return { ok: true, now: clock.advance(ms) };
  });

  return app;
}
