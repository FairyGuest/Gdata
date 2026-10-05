// Minimal HTTP adapter with a Fastify-shaped route contract
// (method+path -> handler(req, reply)). The service is written against this
// interface so the Fastify implementation can be dropped in when the
// dependency is installable; the default implementation uses node:http
// because this environment has no registry access.

import http from "node:http";
import { toErrorBody } from "./errors.ts";

export interface RouteRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface RouteReply {
  status(code: number): RouteReply;
  send(payload: unknown): void;
}

export type Handler = (req: RouteRequest, reply: RouteReply) => Promise<void> | void;

export interface HttpAdapter {
  route(method: string, path: string, handler: Handler): void;
  listen(port: number, host?: string): Promise<{ port: number }>;
  close(): Promise<void>;
}

interface RouteEntry { method: string; segments: string[]; handler: Handler }

export class NodeHttpAdapter implements HttpAdapter {
  private routes: RouteEntry[] = [];
  private server: http.Server | null = null;

  route(method: string, path: string, handler: Handler): void {
    this.routes.push({ method: method.toUpperCase(), segments: path.split("/").filter(Boolean), handler });
  }

  private match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split("/").filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = r.segments[i];
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) { ok = false; break; }
      }
      if (ok) return { handler: r.handler, params };
    }
    return null;
  }

  listen(port: number, host = "127.0.0.1"): Promise<{ port: number }> {
    this.server = http.createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const m = this.match(req.method ?? "GET", url.pathname);
        const reply: RouteReply = {
          _status: 200,
          status(code: number) { this._status = code; return this; },
          send(payload: unknown) {
            const body = payload === undefined ? "" : JSON.stringify(payload);
            res.writeHead(this._status, { "content-type": "application/json; charset=utf-8" });
            res.end(body);
          },
        } as RouteReply & { _status: number };
        if (!m) {
          const { status, body } = toErrorBody(new (await import("./errors.ts")).AppError("NOT_FOUND", `no route for ${req.method} ${url.pathname}`));
          reply.status(status).send(body);
          return;
        }
        let body: unknown = undefined;
        if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const text = Buffer.concat(chunks).toString("utf8");
          if (text.length > 0) {
            try { body = JSON.parse(text); }
            catch {
              const { status, body: errBody } = toErrorBody(new (await import("./errors.ts")).AppError("INPUT_ERROR", "request body is not valid JSON"));
              reply.status(status).send(errBody);
              return;
            }
          }
        }
        const query: Record<string, string> = {};
        for (const [k, v] of url.searchParams) query[k] = v;
        try {
          await m.handler({ params: m.params, query, body }, reply);
        } catch (err) {
          const { status, body: errBody } = toErrorBody(err);
          reply.status(status).send(errBody);
        }
      })();
    });
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => {
        const addr = this.server!.address();
        resolve({ port: typeof addr === "object" && addr ? addr.port : port });
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}
