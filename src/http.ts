// Thin HTTP adapter layer (node:http). Keeps routing/JSON/error mapping in one place so the
// transport can be swapped for Fastify without touching kernel/state/store (see README).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ChaosError, log } from './contracts.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  body: unknown;
  requestId: string;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler; }

export class Router {
  private routes: Route[] = [];
  private fallback: Handler | null = null;

  add(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
    this.routes.push({ method, pattern, keys, handler });
  }
  get(p: string, h: Handler) { this.add('GET', p, h); }
  post(p: string, h: Handler) { this.add('POST', p, h); }
  setFallback(h: Handler) { this.fallback = h; }

  async dispatch(ctx: Ctx): Promise<boolean> {
    const url = new URL(ctx.req.url ?? '/', 'http://x');
    for (const r of this.routes) {
      if (r.method !== ctx.req.method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      r.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });
      await r.handler(ctx);
      return true;
    }
    if (this.fallback) { await this.fallback(ctx); return true; }
    return false;
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'x-chaos': 'admin' });
  res.end(body);
}

export function sendError(res: ServerResponse, requestId: string, err: unknown): void {
  const e = err instanceof ChaosError ? err : new ChaosError('INTERNAL', (err as Error)?.message ?? 'unknown error');
  log(process.env.CHAOS_RUN_ID ?? '-', e.code === 'INTERNAL' ? 'error' : 'warn', 'http.error', {
    requestId, code: e.code, reason: e.message,
  });
  sendJson(res, e.httpStatus, { error: { code: e.code, message: e.message, requestId } });
}

export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); } catch { throw ChaosError.invalidConfig('request body is not valid JSON'); }
}

export function createHttpServer(router: Router, requestIdOf: () => string): Server {
  return createServer(async (req, res) => {
    const requestId = requestIdOf();
    try {
      const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : undefined;
      const handled = await router.dispatch({ req, res, params: {}, body, requestId });
      if (!handled) sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'no route', requestId } });
    } catch (err) {
      if (!res.headersSent) sendError(res, requestId, err);
      else res.destroy();
    }
  });
}
