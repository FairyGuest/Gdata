// Minimal Fastify-compatible subset for offline environments.
// Supports: fastify(opts), .get/.post, .listen({port,host}), .inject(), .close(),
// JSON body parsing, route params (:id).
import http from 'node:http';

function compilePath(path) {
  const keys = [];
  const pattern = path.replace(/:[^/]+/g, (m) => {
    keys.push(m.slice(1));
    return '([^/]+)';
  });
  return { regex: new RegExp('^' + pattern + '$'), keys };
}

export default function fastify(opts = {}) {
  const routes = [];
  const server = http.createServer((req, res) => { handle(req, res); });

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (chunks.length === 0) return undefined;
    const raw = Buffer.concat(chunks).toString('utf8');
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/json')) {
      try {
        return JSON.parse(raw);
      } catch {
        const err = new Error('Body is not valid JSON');
        err.statusCode = 400;
        err.code = 'FST_ERR_CTP_INVALID_JSON';
        throw err;
      }
    }
    return raw;
  }

  function sendJson(res, status, payload, headers = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(body);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const method = req.method.toUpperCase();
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(url.pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const request = {
        method,
        url: url.pathname,
        params,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: undefined,
      };
      const reply = {
        statusCode: 200,
        _headers: {},
        code(c) { this.statusCode = c; return this; },
        header(k, v) { this._headers[k.toLowerCase()] = v; return this; },
        send(payload) {
          sendJson(res, this.statusCode, payload === undefined ? {} : payload, this._headers);
          return this;
        },
      };
      try {
        request.body = await readBody(req);
        const out = await r.handler(request, reply);
        if (!res.writableEnded) {
          if (out !== undefined) reply.send(out);
          else reply.send({});
        }
      } catch (err) {
        if (!res.writableEnded) {
          sendJson(res, err.statusCode || 500, {
            error: { code: err.code || 'INTERNAL_ERROR', message: err.message },
          });
        }
      }
      return;
    }
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Route ' + method + ' ' + url.pathname + ' not found' } });
  }

  function addRoute(method, path, handler) {
    const { regex, keys } = compilePath(path);
    routes.push({ method, regex, keys, handler });
  }

  return {
    get: (p, h) => addRoute('GET', p, h),
    post: (p, h) => addRoute('POST', p, h),
    put: (p, h) => addRoute('PUT', p, h),
    delete: (p, h) => addRoute('DELETE', p, h),
    listen({ port = 3000, host = '127.0.0.1' } = {}) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve('http://' + host + ':' + server.address().port));
      });
    },
    async inject({ method = 'GET', url = '/', payload, headers = {} }) {
      const address = await new Promise((resolve) => {
        if (server.listening) return resolve(server.address());
        server.listen(0, '127.0.0.1', () => resolve(server.address()));
      });
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      const resp = await fetch('http://127.0.0.1:' + address.port + url, {
        method,
        headers: body ? { 'content-type': 'application/json', ...headers } : headers,
        body,
      });
      const text = await resp.text();
      return {
        statusCode: resp.status,
        headers: Object.fromEntries(resp.headers),
        body: text,
        json: () => JSON.parse(text),
      };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
