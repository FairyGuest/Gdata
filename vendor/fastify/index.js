// Minimal Fastify-compatible HTTP framework (offline vendored subset).
// Implements: fastify(), app.get/post/put/patch/delete(route, handler),
// req.params/query/body/headers, reply.code().send(), app.listen(), app.close().
import http from 'node:http';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function compileRoute(path) {
  const names = [];
  const pattern = path.replace(/[.*+?^$()|[\]\\]/g, (m) => (m === '/' ? '/' : '\\' + m));
  const rx = new RegExp('^' + pattern.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, n) => {
    names.push(n);
    return '([^/]+)';
  }) + '/?$');
  return { rx, names };
}

class Reply {
  constructor(res) {
    this.res = res;
    this.statusCode = 200;
    this.sent = false;
  }
  code(n) { this.statusCode = n; return this; }
  header(k, v) { this.res.setHeader(k, v); return this; }
  send(payload) {
    if (this.sent) return;
    this.sent = true;
    let body = payload;
    if (body !== undefined && body !== null && typeof body === 'object') {
      if (!this.res.hasHeader('content-type')) this.res.setHeader('content-type', 'application/json; charset=utf-8');
      body = JSON.stringify(body);
    }
    if (body === undefined) body = '';
    this.res.writeHead(this.statusCode);
    this.res.end(body);
  }
}

class FastifyLike {
  constructor(opts = {}) {
    this.opts = opts;
    this.routes = [];
    this.errorHandler = null;
    this.server = null;
    this.log = opts.logger ? console : null;
  }
  setErrorHandler(fn) { this.errorHandler = fn; return this; }
  route(method, path, handler) {
    const { rx, names } = compileRoute(path);
    this.routes.push({ method, path, rx, names, handler });
    return this;
  }
  async _handle(req, res) {
    const reply = new Reply(res);
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      const route = this.routes.find((r) => r.method === req.method && r.rx.test(pathname));
      if (!route) {
        reply.code(404).send({ error: { category: 'NOT_FOUND', message: `route ${req.method} ${pathname} not found` } });
        return;
      }
      const m = pathname.match(route.rx);
      const params = {};
      route.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      const query = Object.fromEntries(url.searchParams.entries());
      let body = undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.length > 0) {
          const ct = String(req.headers['content-type'] || '');
          if (ct.includes('application/json') || raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
            try { body = JSON.parse(raw); }
            catch (e) {
              const err = new Error('malformed JSON body: ' + e.message);
              err.statusCode = 400;
              throw err;
            }
          } else body = raw;
        }
      }
      const request = { method: req.method, url: req.url, params, query, body, headers: req.headers, raw: req };
      const out = await route.handler(request, reply);
      if (!reply.sent && out !== undefined) reply.send(out);
      if (!reply.sent) reply.send();
    } catch (err) {
      if (this.errorHandler) {
        try { await this.errorHandler(err, req, reply); } catch (e2) { /* fall through */ }
      }
      if (!reply.sent) {
        reply.code(err.statusCode || 500).send({ error: { category: 'COMPUTATION_FAILURE', message: String(err && err.message || err) } });
      }
    }
  }
  listen({ port = 3000, host = '127.0.0.1' } = {}) {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => { this._handle(req, res); });
      this.server.on('error', reject);
      this.server.listen(port, host, () => {
        const addr = this.server.address();
        resolve(`http://${host}:${addr.port}`);
      });
    });
  }
  close() {
    return new Promise((resolve) => { if (!this.server) return resolve(); this.server.close(() => resolve()); });
  }
}

for (const m of METHODS) {
  FastifyLike.prototype[m.toLowerCase()] = function (path, handler) { return this.route(m, path, handler); };
}

export default function fastify(opts) { return new FastifyLike(opts); }
export { fastify };
