// 极简 HTTP 路由层（Fastify 风格 API：route({method,url,handler})）。
// 说明：沙箱无网络无法安装 fastify，接口形状保持一致，可平滑替换。

import http from "node:http";
import { AppError, inputError } from "../diagnostics/errors.ts";

export interface Req {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface Reply {
  status(code: number): Reply;
  send(payload: unknown): void;
}

type Handler = (req: Req, reply: Reply) => Promise<void> | void;

interface Route {
  method: string;
  pattern: string;
  keys: string[];
  regex: RegExp;
  handler: Handler;
}

export function createRouter() {
  const routes: Route[] = [];

  function route(def: { method: string; url: string; handler: Handler }) {
    const keys: string[] = [];
    const regex = new RegExp(
      "^" +
        def.url.replace(/:[^/]+/g, (m) => {
          keys.push(m.slice(1));
          return "([^/]+)";
        }) +
        "$",
    );
    routes.push({ method: def.method, pattern: def.url, keys, regex, handler: def.handler });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));
    const hit = routes.find((r) => r.method === req.method && r.regex.test(url.pathname));
    const reply: Reply = {
      status(code: number) {
        res.statusCode = code;
        return this;
      },
      send(payload: unknown) {
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify(payload));
      },
    };
    try {
      if (!hit) {
        throw new AppError("NOT_FOUND", `no route ${req.method} ${url.pathname}`, 404);
      }
      const m = url.pathname.match(hit.regex)!;
      const params: Record<string, string> = {};
      hit.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      let body: unknown = undefined;
      if (req.method === "POST" || req.method === "PUT") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.length > 0) {
          try {
            body = JSON.parse(text);
          } catch {
            throw inputError("request body is not valid JSON");
          }
        }
      }
      await hit.handler({ params, query, body }, reply);
    } catch (e) {
      const err =
        e instanceof AppError
          ? e
          : new AppError("COMPUTATION_FAILED", String((e as Error).message ?? e), 500);
      res.statusCode = err.httpStatus;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: { code: err.code, message: err.message, details: err.details ?? null } }));
    }
  }

  function listen(port: number, host: string): Promise<http.Server> {
    const server = http.createServer((req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
    });
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
  }

  return { route, listen };
}
