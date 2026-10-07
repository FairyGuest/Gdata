import http from 'node:http';

/**
 * Minimal Fastify-compatible HTTP adapter (offline fallback).
 * Supports the subset of the Fastify API this service uses:
 * register routes with :params, async handlers, app.inject() for tests,
 * and app.listen(). When the real 'fastify' package is installable,
 * src/http/server.ts can switch to it without route changes (see README).
 */

export interface LiteRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface LiteReply {
  status(code: number): LiteReply;
  send(payload: unknown): void;
}

type Handler = (req: LiteRequest, reply: LiteReply) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: string;
  keys: string[];
  regex: RegExp;
  handler: Handler;
}

function compile(pattern: string): { keys: string[]; regex: RegExp } {
  const keys: string[] = [];
  const rx = pattern.split('/').map((seg) => {
    if (seg.startsWith(':')) {
      keys.push(seg.slice(1));
      return '([^/]+)';
    }
    return seg.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  }).join('/');
  return { keys, regex: new RegExp('^' + rx + '$') };
}

export class FastifyLite {
  private routes: Route[] = [];

  private add(method: string, pattern: string, handler: Handler): void {
    const { keys, regex } = compile(pattern);
    this.routes.push({ method, pattern, keys, regex, handler });
  }
  get(p: string, h: Handler): void { this.add('GET', p, h); }
  post(p: string, h: Handler): void { this.add('POST', p, h); }
  delete(p: string, h: Handler): void { this.add('DELETE', p, h); }

  private async dispatch(method: string, url: string, body: unknown) {
    const u = new URL(url, 'http://localhost');
    const path = decodeURIComponent(u.pathname);
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
      const query: Record<string, string> = {};
      u.searchParams.forEach((v, k) => { query[k] = v; });
      let statusCode = 200;
      const reply: LiteReply = {
        status(code: number) { statusCode = code; return this; },
        send(payload: unknown) { (this as any)._payload = payload; },
      };
      const result = await r.handler({ params, query, body }, reply);
      const payload = (reply as any)._payload !== undefined ? (reply as any)._payload : result;
      return { statusCode, payload };
    }
    return { statusCode: 404, payload: { error: { category: 'NOT_FOUND', message: 'route not found: ' + method + ' ' + path } } };
  }

  /** Fastify-style in-process injection for tests. */
  async inject(opts: { method: string; url: string; payload?: unknown }) {
    const res = await this.dispatch(opts.method.toUpperCase(), opts.url, opts.payload);
    return {
      statusCode: res.statusCode,
      json: () => res.payload,
      body: JSON.stringify(res.payload ?? null),
    };
  }

  listen(opts: { port: number; host?: string }): Promise<string> {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        let body: unknown;
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw) {
          try { body = JSON.parse(raw); } catch { body = undefined; }
        }
        try {
          const out = await this.dispatch(req.method!, req.url!, body);
          res.writeHead(out.statusCode, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out.payload ?? null));
        } catch (e: any) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { category: 'INTERNAL', message: String(e?.message ?? e) } }));
        }
      });
    });
    return new Promise((resolve) => {
      server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
        const addr = server.address() as any;
        resolve('http://127.0.0.1:' + addr.port);
      });
    });
  }
}

export function fastify(): FastifyLite {
  return new FastifyLite();
}
