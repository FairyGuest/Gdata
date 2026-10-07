// Minimal Fastify-style HTTP adapter over node:http.
// (The offline sandbox cannot install fastify; the route/handler shape and
// error mapping mirror Fastify conventions so the adapter can be swapped.)

import http from 'node:http';
import { DomainError, isDomainError } from '../domain/errors.ts';
import type { Provisioner } from '../kernel/provisioner.ts';
import type { VirtualClock } from '../kernel/clock.ts';
import type { InstanceStatus } from '../domain/types.ts';

const STATUS_BY_CODE: Record<string, number> = {
  TEMPLATE_VALIDATION: 400,
  OVERRIDE_INVALID: 400,
  INSTANCE_NOT_FOUND: 404,
  NAME_CONFLICT: 409,
  INVALID_TRANSITION: 409,
  TERMINAL_STATE: 410,
  RESOURCE_EXHAUSTED: 429,
  INTERNAL: 500,
};

type Handler = (req: http.IncomingMessage, ctx: {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}) => unknown | Promise<unknown>;

const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];

function route(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, (_, k) => {
    keys.push(k);
    return '([^/]+)';
  }) + '$');
  routes.push({ method, pattern, keys, handler });
}

export function buildServer(provisioner: Provisioner, clock: VirtualClock): http.Server {
  routes.length = 0;

  route('GET', '/health', () => ({ ok: true }));

  route('POST', '/templates', (_req, { body }) => {
    const t = provisioner.registerTemplate(body);
    return { status: 201, body: t };
  });

  route('GET', '/templates', () => provisioner.listTemplates());

  route('POST', '/instances', (_req, { body }) => {
    const inst = provisioner.provision(body as any);
    return { status: 201, body: inst };
  });

  route('GET', '/instances', (_req, { query }) => {
    const q: { template?: string; status?: InstanceStatus } = {};
    if (query.get('template')) q.template = query.get('template')!;
    if (query.get('status')) q.status = query.get('status') as InstanceStatus;
    return provisioner.query(q);
  });

  route('GET', '/instances/:name', (_req, { params }) => provisioner.get(params.name));

  route('GET', '/instances/:name/history', (_req, { params }) => provisioner.history(params.name));

  route('POST', '/instances/:name/resume', (_req, { params }) => provisioner.resume(params.name));

  route('DELETE', '/instances/:name', (_req, { params }) => provisioner.delete(params.name));

  route('GET', '/diagnostics', () => provisioner.diagnostics());

  // Test/demo hook: advance the injected virtual clock.
  route('POST', '/clock/advance', (_req, { body }) => {
    const ms = (body as any)?.ms;
    if (typeof ms !== 'number' || ms < 0) {
      throw new DomainError('TEMPLATE_VALIDATION', 'ms must be a non-negative number');
    }
    clock.advance(ms);
    return { now: clock.now() };
  });

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!match) {
        return send(res, 404, { error: { code: 'INSTANCE_NOT_FOUND', message: 'route not found' } });
      }
      const params: Record<string, string> = {};
      const m = url.pathname.match(match.pattern)!;
      match.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const body = await readBody(req);
      const result = await match.handler(req, { params, query: url.searchParams, body });
      if (result && typeof result === 'object' && 'status' in (result as any) && 'body' in (result as any)) {
        const r = result as { status: number; body: unknown };
        return send(res, r.status, r.body);
      }
      return send(res, 200, result);
    } catch (err) {
      if (isDomainError(err)) {
        return send(res, STATUS_BY_CODE[err.code] ?? 500, {
          error: { code: err.code, message: err.message, details: err.details ?? null },
        });
      }
      const e = err as Error;
      return send(res, 500, { error: { code: 'INTERNAL', message: e.message ?? 'internal error' } });
    }
  });
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new DomainError('TEMPLATE_VALIDATION', 'request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
