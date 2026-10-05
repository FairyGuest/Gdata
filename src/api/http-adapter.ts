import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { toErrorBody } from '../contract/errors.ts';
import { ServiceError } from '../contract/errors.ts';

export interface HttpRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  body: unknown;
}

export interface HttpResult {
  status: number;
  body: unknown;
}

export type RouteHandler = (req: HttpRequest) => Promise<HttpResult> | HttpResult;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

const MAX_BODY_BYTES = 1024 * 1024;

// Minimal HTTP adapter with a Fastify-shaped contract (register routes with
// :param patterns, handlers return {status, body}). The diagnostic API only
// depends on this interface, so a real Fastify adapter can be dropped in
// without touching routes or kernel code (see README "Stack notes").
export class NodeHttpAdapter {
  private routes: Route[] = [];
  private server: Server | null = null;

  register(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({ method, segments: path.split('/').filter(Boolean), handler });
  }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const segments = path.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segments.length; i++) {
        const want = route.segments[i]!;
        const got = segments[i]!;
        if (want.startsWith(':')) params[want.slice(1)] = decodeURIComponent(got);
        else if (want !== got) { ok = false; break; }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        throw new ServiceError('RESOURCE_EXHAUSTED', `request body exceeds ${MAX_BODY_BYTES} bytes`);
      }
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return undefined;
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      throw new ServiceError('INPUT_ERROR', 'request body is not valid JSON');
    }
  }

  async listen(port: number): Promise<number> {
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      let status = 500;
      let body: unknown = { error: { code: 'INTERNAL_ERROR', message: 'unhandled' } };
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const matched = this.match(req.method ?? 'GET', url.pathname);
        if (!matched) {
          status = 404;
          body = { error: { code: 'NOT_FOUND', message: `no route ${req.method} ${url.pathname}` } };
        } else {
          const result = await matched.route.handler({
            method: req.method ?? 'GET',
            path: url.pathname,
            params: matched.params,
            body: await this.readBody(req),
          });
          status = result.status;
          body = result.body;
        }
      } catch (err) {
        const mapped = toErrorBody(err);
        status = mapped.status;
        body = mapped.body;
      }
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, () => resolve());
    });
    const addr = this.server.address();
    return typeof addr === 'object' && addr ? addr.port : port;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
