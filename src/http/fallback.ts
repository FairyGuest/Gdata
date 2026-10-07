import http from 'node:http';

export interface FallbackRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: http.IncomingHttpHeaders;
}

export interface FallbackReply {
  statusCode: number;
  code(status: number): FallbackReply;
  send(payload: unknown): unknown;
}

export interface InjectResponse {
  statusCode: number;
  body: string;
  json(): unknown;
}

type Handler = (req: FallbackRequest, reply: FallbackReply) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: string;
  segments: string[];
  handler: Handler;
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const p = pattern[i];
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(actual[i]);
    } else if (p !== actual[i]) {
      return null;
    }
  }
  return params;
}

export class MiniFastify {
  private readonly routes: Route[] = [];

  private readonly maxBodyBytes: number;

  constructor(maxBodyBytes: number) {
    this.maxBodyBytes = maxBodyBytes;
  }

  private add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, pattern, segments: pattern.split('/').filter(Boolean), handler });
  }

  get(pattern: string, handler: Handler): void {
    this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): void {
    this.add('POST', pattern, handler);
  }

  put(pattern: string, handler: Handler): void {
    this.add('PUT', pattern, handler);
  }

  private async dispatch(method: string, rawUrl: string, rawBody: string): Promise<{ statusCode: number; body: string }> {
    const url = new URL(rawUrl, 'http://localhost');
    const actual = url.pathname.split('/').filter(Boolean);
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchSegments(route.segments, actual);
      if (!params) continue;
      let body: unknown = undefined;
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          return { statusCode: 400, body: JSON.stringify({ error: { category: 'INPUT_ERROR', code: 'INVALID_JSON', message: 'request body is not valid JSON', details: null } }) };
        }
      }
      const reply: FallbackReply = {
        statusCode: 200,
        code(status: number) {
          this.statusCode = status;
          return this;
        },
        send(payload: unknown) {
          return payload;
        },
      };
      const result = await route.handler({ params, query, body, headers: {} }, reply);
      return { statusCode: reply.statusCode, body: JSON.stringify(result ?? null) };
    }
    return { statusCode: 404, body: JSON.stringify({ error: { category: 'NOT_FOUND', code: 'ROUTE_NOT_FOUND', message: method + ' ' + url.pathname + ' is not a registered route', details: null } }) };
  }

  async inject(opts: { method: string; url: string; payload?: unknown }): Promise<InjectResponse> {
    const rawBody = opts.payload === undefined ? '' : JSON.stringify(opts.payload);
    const { statusCode, body } = await this.dispatch(opts.method.toUpperCase(), opts.url, rawBody);
    return { statusCode, body, json: () => JSON.parse(body) };
  }

  async listen(opts: { port: number; host?: string }): Promise<void> {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.maxBodyBytes) {
          tooBig = true;
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        void (async () => {
          if (tooBig) {
            res.writeHead(507, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { category: 'RESOURCE_EXHAUSTED', code: 'PAYLOAD_TOO_LARGE', message: 'request body exceeds configured limit', details: { maxBodyBytes: this.maxBodyBytes } } }));
            return;
          }
          const rawBody = Buffer.concat(chunks).toString('utf8');
          const { statusCode, body } = await this.dispatch(req.method ?? 'GET', req.url ?? '/', rawBody);
          res.writeHead(statusCode, { 'content-type': 'application/json' });
          res.end(body);
        })();
      });
    });
    await new Promise<void>((resolve) => server.listen(opts.port, opts.host ?? '127.0.0.1', resolve));
    this.server = server;
  }

  private server: http.Server | null = null;

  async close(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    }
  }
}
