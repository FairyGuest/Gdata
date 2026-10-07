// HTTP adapter contract. The default implementation below uses node:http so
// the service runs with zero external dependencies; a Fastify adapter can
// implement the same AppAdapter interface and be dropped in without touching
// routes or kernels (see README "Swapping in Fastify").

import { createServer } from "node:http";
import type { Server } from "node:http";
import { AppError, toAppError } from "../contracts/errors.ts";

export interface HttpRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

export type RouteHandler = (req: HttpRequest) => Promise<HttpResponse> | HttpResponse;

export interface Route {
  method: "GET" | "POST";
  pattern: RegExp;
  keys: string[];
  handler: (req: HttpRequest, params: Record<string, string>) => Promise<HttpResponse> | HttpResponse;
}

export const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

export class Router {
  private routes: Route[] = [];

  add(method: "GET" | "POST", path: string, handler: Route["handler"]): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" + path.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return "([^/]+)"; }) + "$"
    );
    this.routes.push({ method, pattern, keys, handler });
  }

  async dispatch(req: HttpRequest): Promise<HttpResponse> {
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(req.path);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1]!); });
      return route.handler(req, params);
    }
    throw new AppError("NOT_FOUND", `no route for ${req.method} ${req.path}`);
  }
}

export interface AppAdapter {
  listen(port: number, host: string): Promise<{ port: number }>;
  close(): Promise<void>;
}

export function createNodeHttpAdapter(router: Router): AppAdapter {
  const server: Server = createServer(async (rawReq, rawRes) => {
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      rawRes.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      rawRes.end(payload);
    };
    try {
      const url = new URL(rawReq.url ?? "/", "http://localhost");
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => { query[k] = v; });
      let body: unknown;
      if (rawReq.method === "POST") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of rawReq) {
          size += (chunk as Buffer).length;
          if (size > MAX_BODY_BYTES) {
            throw new AppError("RESOURCE_EXHAUSTED", `request body exceeds ${MAX_BODY_BYTES} bytes`, { limit: MAX_BODY_BYTES });
          }
          chunks.push(chunk as Buffer);
        }
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.length > 0) {
          try {
            body = JSON.parse(text);
          } catch {
            throw new AppError("INPUT_ERROR", "request body is not valid JSON");
          }
        }
      }
      const response = await router.dispatch({ method: rawReq.method ?? "GET", path: url.pathname, query, body });
      send(response.status, response.body);
    } catch (err) {
      const appErr = toAppError(err);
      send(appErr.httpStatus, appErr.toJSON());
    }
  });
  return {
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const addr = server.address();
          resolve({ port: typeof addr === "object" && addr !== null ? addr.port : port });
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
