// Fastify 兼容微层：与 fastify 对齐的最小 API 子集（get/post、路径参数、JSON、inject、listen）。
// 本环境离线无法安装 fastify；接口对齐后可在有网环境零改动替换为真实 fastify。
import http from 'node:http';

export interface LiteRequest { params: Record<string, string>; body: unknown; }
export type Handler = (req: LiteRequest, reply: LiteReply) => unknown | Promise<unknown>;

interface LiteReply {
  status(code: number): LiteReply;
  send(payload: unknown): void;
  _status: number;
  _payload: unknown;
}

interface Route { method: string; pattern: string; keys: string[]; regex: RegExp; handler: Handler; }

function compile(pattern: string): { keys: string[]; regex: RegExp } {
  const keys: string[] = [];
  const rx = pattern.split('/').map((seg) => {
    if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
    return seg.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  }).join('/');
  return { keys, regex: new RegExp('^' + rx + '$') };
}

export function createApp() {
  const routes: Route[] = [];
  const add = (method: string) => (pattern: string, handler: Handler) => {
    const { keys, regex } = compile(pattern);
    routes.push({ method, pattern, keys, regex, handler });
  };

  const dispatch = async (method: string, url: string, body: unknown) => {
    const path = url.split('?')[0];
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const reply: LiteReply = {
        _status: 200, _payload: undefined,
        status(code: number) { this._status = code; return this; },
        send(payload: unknown) { this._payload = payload; },
      };
      const result = await r.handler({ params, body }, reply);
      const payload = reply._payload !== undefined ? reply._payload : result;
      return { status: reply._status, payload };
    }
    return { status: 404, payload: { error: { category: 'INPUT_ERROR', message: `route not found: ${method} ${path}` } } };
  };

  return {
    get: add('GET'),
    post: add('POST'),
    inject: async (opts: { method: string; url: string; payload?: unknown }) =>
      dispatch(opts.method, opts.url, opts.payload),
    listen: (port: number, host: string): Promise<http.Server> =>
      new Promise((resolveListen, rejectListen) => {
        const server = http.createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', async () => {
            let body: unknown;
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw) {
              try { body = JSON.parse(raw); }
              catch {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { category: 'INPUT_ERROR', message: 'request body is not valid JSON' } }));
                return;
              }
            }
            try {
              const out = await dispatch(req.method ?? 'GET', req.url ?? '/', body);
              res.writeHead(out.status, { 'content-type': 'application/json' });
              res.end(JSON.stringify(out.payload ?? null));
            } catch (e) {
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: { category: 'COMPUTATION_FAILURE', message: String(e) } }));
            }
          });
        });
        server.on('error', rejectListen);
        server.listen(port, host, () => resolveListen(server));
      }),
  };
}

export type App = ReturnType<typeof createApp>;
