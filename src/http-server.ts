/**
 * Fallback HTTP adapter built on node:http (zero dependencies).
 * Used when fastify is not installed (e.g. offline environments).
 */
import { createServer, type Server } from "node:http";
import type { Service } from "./service.ts";

const MAX_BODY_BYTES = 1_000_000;

export async function startHttpServer(service: Service, host: string, port: number): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "RESOURCE_EXHAUSTED", category: "resource", message: "request body too large", details: null } }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://localhost");
        let body: unknown = undefined;
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { code: "SCHEMA_VALIDATION", category: "input", message: "request body is not valid JSON", details: null } }));
            return;
          }
        }
        const result = await service.handle(req.method ?? "GET", url.pathname, body, url.searchParams);
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(JSON.stringify(result.body));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  return { server, port: actualPort };
}
