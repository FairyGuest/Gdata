// Minimal Fastify-compatible subset for offline environments.
// Supports: fastify(), .get/.post/.put/.delete(path, handler), .listen(port, host),
// .inject({method, url, payload}), .setErrorHandler(fn), .close().
import http from 'node:http';

function compilePath(pattern) {
  const keys = [];
  const escaped = pattern.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const withParams = escaped.replace(/:([A-Za-z_]+)/g, function (_, k) {
    keys.push(k);
    return '([^/]+)';
  });
  return { regex: new RegExp('^' + withParams + '$'), keys };
}

export default function fastify() {
  const routes = [];
  let errorHandler = null;
  let server = null;

  const addRoute = (method, path, handler) => {
    routes.push({ method, ...compilePath(path), handler });
  };

  async function dispatch(req, res, body) {
    const url = new URL(req.url, 'http://localhost');
    const query = Object.fromEntries(url.searchParams.entries());
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const m = route.regex.exec(url.pathname);
      if (!m) continue;
      const params = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      let payload = body;
      if (body && (req.headers['content-type'] || '').includes('application/json')) {
        try { payload = JSON.parse(body); } catch { payload = undefined; }
      }
      const request = { params, query, body: payload, headers: req.headers, url: req.url, method: req.method };
      const reply = {
        statusCode: 200,
        code(n) { this.statusCode = n; return this; },
        async send(data) {
          const isObj = data !== null && typeof data === 'object';
          const out = isObj ? JSON.stringify(data) : String(data == null ? '' : data);
          res.writeHead(this.statusCode, { 'content-type': isObj ? 'application/json' : 'text/plain' });
          res.end(out);
          return this;
        },
      };
      try {
        const result = await route.handler(request, reply);
        if (!res.writableEnded && result !== undefined) await reply.send(result);
      } catch (err) {
        if (res.writableEnded) return;
        if (errorHandler) await errorHandler(err, request, reply);
        if (!res.writableEnded) {
          await reply.code(500).send({ error: { code: 'INTERNAL', message: String((err && err.message) || err) } });
        }
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'No route ' + req.method + ' ' + url.pathname } }));
  }

  function createDispatchServer() {
    return http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => dispatch(req, res, Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => res.destroy());
    });
  }

  return {
    get: (p, h) => addRoute('GET', p, h),
    post: (p, h) => addRoute('POST', p, h),
    put: (p, h) => addRoute('PUT', p, h),
    delete: (p, h) => addRoute('DELETE', p, h),
    setErrorHandler(fn) { errorHandler = fn; },
    async listen(port, host) {
      host = host || '127.0.0.1';
      server = createDispatchServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return 'http://' + host + ':' + server.address().port;
    },
    async inject(opts) {
      const srv = createDispatchServer();
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const port = srv.address().port;
      try {
        const resp = await fetch('http://127.0.0.1:' + port + opts.url, {
          method: opts.method,
          headers: opts.payload !== undefined ? { 'content-type': 'application/json' } : {},
          body: opts.payload !== undefined ? JSON.stringify(opts.payload) : undefined,
        });
        const text = await resp.text();
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        return { statusCode: resp.status, body: text, json: () => json, headers: Object.fromEntries(resp.headers.entries()) };
      } finally {
        await new Promise((r) => srv.close(r));
      }
    },
    async close() { if (server) await new Promise((r) => server.close(r)); },
  };
}
