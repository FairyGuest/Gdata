// Diagnostic HTTP interface. Uses Fastify when it is installed (optional
// dependency); otherwise falls back to a node:http adapter exposing the
// same route table, so the service runs with zero external dependencies.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { LifecycleError } from './errors.ts';
import type { LifecycleKernel } from './core/lifecycle.ts';
import type { EnvironmentStore, EnvStatus } from './store/sqliteStore.ts';
import type { VirtualClock } from './clock.ts';

export interface HttpApp {
  listen(port: number, host?: string): Promise<void>;
  close(): Promise<void>;
  port(): number;
}

const STATUS_BY_CATEGORY: Record<string, number> = {
  validation: 400,
  conflict: 409,
  quota_exceeded: 429,
  not_found: 404,
  internal: 500,
};

export function errorBody(err: unknown): { status: number; body: unknown } {
  if (err instanceof LifecycleError) {
    return {
      status: STATUS_BY_CATEGORY[err.category] ?? 500,
      body: { error: { code: err.code, category: err.category, message: err.message, details: err.details } },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: { code: 'INTERNAL', category: 'internal', message, details: {} } } };
}

type Handler = (req: { params: Record<string, string>; query: URLSearchParams; body: unknown }) => Promise<unknown> | unknown;

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

function compilePath(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const pattern = new RegExp('^' + path.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  return { pattern, keys };
}

export function buildApp(kernel: LifecycleKernel, store: EnvironmentStore, clock: VirtualClock | null): HttpApp {
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler) => {
    const { pattern, keys } = compilePath(path);
    routes.push({ method, pattern, keys, handler });
  };

  add('GET', '/health', () => ({ ok: true, now: kernelNow() }));
  add('POST', '/environments', async ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const outcome = await kernel.create({
      branch: b.branch as string,
      owner: b.owner as string,
      overrides: b.overrides as Record<string, unknown> | undefined,
      ttlSeconds: b.ttlSeconds as number | undefined,
    });
    return { status: outcome.idempotent ? 200 : 201, body: { env: outcome.env, idempotent: outcome.idempotent } };
  });
  add('POST', '/environments/:id/renew', ({ params }) => ({ env: kernel.renew(params.id) }));
  add('DELETE', '/environments/:id', async ({ params, query, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const env = await kernel.delete(params.id, {
      force: query.get('force') === 'true' || b.force === true,
      reason: (query.get('reason') ?? b.reason) as string | undefined,
      actor: b.actor as string | undefined,
    });
    return { env };
  });
  add('GET', '/environments/:id', ({ params }) => ({ env: kernel.get(params.id) }));
  add('GET', '/environments', ({ query }) => ({
    environments: kernel.list({
      branch: query.get('branch') ?? undefined,
      status: (query.get('status') ?? undefined) as EnvStatus | undefined,
    }),
  }));
  add('GET', '/environments/:id/transitions', ({ params }) => ({ transitions: store.listTransitions(params.id) }));
  add('GET', '/audit', ({ query }) => ({ audit: store.listAudit(query.get('envId') ?? undefined) }));
  add('POST', '/admin/tick', ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    if (clock && typeof b.advanceSeconds === 'number') clock.advanceSeconds(b.advanceSeconds);
    return { now: kernelNow(), ...kernel.tick() };
  });

  function kernelNow(): number { return (clock ? clock.now() : Date.now()); }

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    const send = (status: number, payload: unknown) => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text);
    };
    if (!route) { send(404, { error: { code: 'ROUTE_NOT_FOUND', category: 'not_found', message: `no route ${req.method} ${url.pathname}`, details: {} } }); return; }
    try {
      const match = url.pathname.match(route.pattern)!;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1]); });
      let body: unknown = undefined;
      if (req.method === 'POST' || req.method === 'DELETE' || req.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.length > 0) {
          try { body = JSON.parse(raw); }
          catch { send(400, { error: { code: 'BAD_JSON', category: 'validation', message: 'request body is not valid JSON', details: {} } }); return; }
        }
      }
      const result = await route.handler({ params, query: url.searchParams, body });
      if (result !== undefined && typeof result === 'object' && 'status' in (result as Record<string, unknown>) && 'body' in (result as Record<string, unknown>)) {
        const r = result as { status: number; body: unknown };
        send(r.status, r.body);
      } else {
        send(200, result);
      }
    } catch (err) {
      const { status, body } = errorBody(err);
      send(status, body);
    }
  });

  return {
    listen(port: number, host = '127.0.0.1') {
      return new Promise((resolve) => server.listen(port, host, resolve));
    },
    close() {
      return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
    port() {
      const addr = server.address();
      return typeof addr === 'object' && addr !== null ? addr.port : 0;
    },
  };
}
