import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { AppError, internal, type ErrorReason } from "../kernel/errors.ts";
import type { AppConfig } from "../config.ts";

export interface HttpContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  body: unknown;
  config: AppConfig;
}

type Handler = (ctx: HttpContext) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class HttpApp {
  private readonly routes: Route[] = [];
  readonly server: Server;
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.server = createServer((req, res) => {
      void this.dispatch(req, res);
    });
  }

  add(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const regex = new RegExp(
      "^" +
        path.replace(/:[A-Za-z_]+/g, (m) => {
          keys.push(m.slice(1));
          return "([^/]+)";
        }) +
        "$"
    );
    this.routes.push({ method, pattern: regex, keys, handler });
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = this.routes.find(
        (r) => r.method === (req.method ?? "") && r.pattern.test(url.pathname)
      );
      if (!route) {
        this.sendError(res, new AppError(404, "not_found", "route not found", { path: url.pathname }));
        return;
      }
      const match = url.pathname.match(route.pattern);
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(match?.[i + 1] ?? "");
      });
      const body = await this.readBody(req);
      const result = await route.handler({ req, res, params, body, config: this.config });
      if (!res.writableEnded && result !== undefined) {
        this.sendJson(res, 200, result);
      } else if (!res.writableEnded) {
        this.sendJson(res, 200, { ok: true });
      }
    } catch (err) {
      this.sendError(res, normalize(err));
    }
  }

  private readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const limit = 1_000_000;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          reject(new AppError(422, "invalid_body", "request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (chunks.length === 0) {
          resolve(undefined);
          return;
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new AppError(422, "invalid_body", "request body is not valid JSON"));
        }
      });
      req.on("error", (err) => reject(internal("request read failed", { cause: err.message })));
    });
  }

  sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const json = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(json);
  }

  sendError(res: ServerResponse, err: AppError): void {
    if (err.statusCode >= 500 || err.statusCode === 409) {
      // conflicts and server errors are logged via the diag route at the service layer
    }
    this.sendJson(res, err.statusCode, err.toBody(this.config.runId));
  }

  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        const addr = this.server.address();
        if (addr && typeof addr === "object") {
          resolve(addr.port);
          return;
        }
        reject(new Error("server has no TCP address"));
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

function normalize(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err && typeof err === "object" && "statusCode" in err && "reason" in err) {
    const e = err as { statusCode: number; reason: ErrorReason; message: string; detail?: unknown };
    return new AppError(e.statusCode, e.reason, e.message, e.detail);
  }
  const message = err instanceof Error ? err.message : String(err);
  return internal("unexpected computation failure", { cause: message });
}

