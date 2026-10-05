import { createServer, type Server } from "node:http";
import type { Router } from "./router.ts";
import { resourceExhausted, inputError, toServiceError } from "../diagnostics/errors.ts";
import { ERROR_HTTP_STATUS } from "../contract/types.ts";

export interface HttpAdapter {
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
  port(): number;
  readonly kind: string;
}

// Fallback adapter built on node:http. Used when fastify is not installed
// (e.g. offline environments). Route semantics match the Fastify adapter.
export class NodeHttpAdapter implements HttpAdapter {
  readonly kind = "node:http";
  private server: Server;

  private readonly router: Router;
  private readonly maxPayloadBytes: number;
  constructor(router: Router, maxPayloadBytes: number) {
    this.router = router;
    this.maxPayloadBytes = maxPayloadBytes;
    this.server = createServer((req, res) => {
      const send = (status: number, body: unknown) => {
        const text = JSON.stringify(body);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(text);
      };
      const fail = (e: unknown) => {
        const err = toServiceError(e);
        send(ERROR_HTTP_STATUS[err.category], { runId: "n/a", error: { category: err.category, code: err.code, message: err.message } });
      };

      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        const r = this.router.health("health");
        send(r.status, r.body);
        return;
      }
      if (method === "GET" && url.pathname.startsWith("/snapshots/")) {
        const r = this.router.getSnapshot(decodeURIComponent(url.pathname.slice("/snapshots/".length)));
        send(r.status, r.body);
        return;
      }
      if (method === "POST" && (url.pathname === "/snapshots/compare" || url.pathname === "/snapshots/create")) {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooBig = false;
        req.on("data", (c: Buffer) => {
          size += c.length;
          if (size > this.maxPayloadBytes) {
            tooBig = true;   // keep draining so the socket stays healthy;
          } else {           // the 507 response is sent on "end"
            chunks.push(c);
          }
        });
        req.on("end", () => {
          if (tooBig) {
            fail(resourceExhausted("PAYLOAD_TOO_LARGE", "request body exceeds " + this.maxPayloadBytes + " bytes"));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            fail(inputError("INVALID_JSON", "request body is not valid JSON"));
            return;
          }
          const r = url.pathname === "/snapshots/compare" ? this.router.compare(parsed) : this.router.create(parsed);
          send(r.status, r.body);
        });
        req.on("error", () => { /* socket errors surface via end/close handlers */ });
        return;
      }
      send(404, { runId: "n/a", error: { category: "INPUT_ERROR", code: "NOT_FOUND", message: "unknown route: " + method + " " + url.pathname } });
    });
  }

  listen(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => resolve());
    });
  }

  port(): number {
    const addr = this.server.address();
    return typeof addr === "object" && addr !== null ? addr.port : 0;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
