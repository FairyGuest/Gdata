// Minimal Fastify-compatible module (offline vendored substitute).
// Implements the subset of the Fastify API used by this service:
//   fastify(), .get(path, handler), .post(path, handler),
//   .inject({method,url,payload}), .listen({port,host}), .close()
// Handlers receive (request, reply); request has { params, query, body, headers }.
// reply.code(n).send(obj) sends JSON; returning an object also sends JSON 200.
import http from "node:http";

function compilePath(pattern) {
  const keys = [];
  const rx = new RegExp("^" + pattern.split("/").map((seg) => {
    if (seg.startsWith(":")) { keys.push(seg.slice(1)); return "([^/]+)"; }
    return seg.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  }).join("/") + "$");
  return { rx, keys };
}

export default function fastify() {
  const routes = [];
  const add = (method, path, handler) => routes.push({ method, path, handler, ...compilePath(path) });
  const app = {
    routes,
    get: (p, h) => add("GET", p, h),
    post: (p, h) => add("POST", p, h),
    delete: (p, h) => add("DELETE", p, h),
    async _handle(method, rawUrl, body) {
      const u = new URL(rawUrl, "http://localhost");
      const query = Object.fromEntries(u.searchParams.entries());
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.rx.exec(u.pathname);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        let statusCode = 200;
        let sent = false;
        let sentPayload;
        const reply = {
          code(n) { statusCode = n; return this; },
          send(payload) { sent = true; sentPayload = payload; return { statusCode, payload }; },
        };
        const req = { params, query, body, headers: {}, method, url: rawUrl };
        const out = await r.handler(req, reply);
        if (sent) return { statusCode, payload: sentPayload };
        if (out !== undefined) return { statusCode, payload: out };
        throw new Error("handler returned undefined without reply.send");
      }
      return { statusCode: 404, payload: { error: { code: "NOT_FOUND", message: "no route " + method + " " + u.pathname } } };
    },
    async inject({ method, url, payload }) {
      const { statusCode, payload: out } = await app._handle(method, url, payload);
      return { statusCode, body: JSON.stringify(out), json: () => out };
    },
    listen({ port, host = "127.0.0.1" } = {}) {
      const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", async () => {
          let body;
          if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = undefined; } }
          try {
            const { statusCode, payload } = await app._handle(req.method, req.url, body);
            res.writeHead(statusCode, { "content-type": "application/json" });
            res.end(JSON.stringify(payload));
          } catch (err) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: String(err && err.message || err) } }));
          }
        });
      });
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => { app._server = server; resolve("http://" + host + ":" + port); });
      });
    },
    async close() { if (app._server) await new Promise((r) => app._server.close(r)); },
  };
  return app;
}

