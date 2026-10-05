/**
 * Server factory: prefers Fastify when installed, otherwise falls back
 * to the zero-dependency node:http adapter. Both expose identical routes.
 */
import type { AppConfig } from "./config.ts";
import { createService, type Service } from "./service.ts";
import { DatasetStore } from "./store.ts";

export interface RunningServer {
  port: number;
  adapter: "fastify" | "node:http";
  service: Service;
  close(): Promise<void>;
}

async function tryFastify(service: Service, host: string, port: number): Promise<RunningServer | null> {
  let fastifyFactory: unknown;
  try {
    ({ default: fastifyFactory } = await import("fastify"));
  } catch {
    return null;
  }
  const app = (fastifyFactory as (opts?: unknown) => any)({ logger: false });
  app.setErrorHandler((err: unknown, _req: unknown, reply: any) => {
    reply.status(400).send({ error: { code: "SCHEMA_VALIDATION", category: "input", message: "request body is not valid JSON", details: null } });
  });
  const wrap = (handler: (req: any, reply: any) => Promise<void>) => handler;
  app.all("/generate", wrap(async (req: any, reply: any) => {
    const r = await service.handle(req.method, "/generate", req.body, new URLSearchParams());
    reply.status(r.status).send(r.body);
  }));
  app.all("/datasets", wrap(async (req: any, reply: any) => {
    const r = await service.handle(req.method, "/datasets", req.body, new URLSearchParams());
    reply.status(r.status).send(r.body);
  }));
  app.all("/datasets/:id", wrap(async (req: any, reply: any) => {
    const r = await service.handle(req.method, "/datasets/" + encodeURIComponent(req.params.id), req.body, new URLSearchParams());
    reply.status(r.status).send(r.body);
  }));
  app.all("/datasets/:id/verify", wrap(async (req: any, reply: any) => {
    const r = await service.handle(req.method, "/datasets/" + encodeURIComponent(req.params.id) + "/verify", req.body, new URLSearchParams());
    reply.status(r.status).send(r.body);
  }));
  app.all("/health", wrap(async (_req: any, reply: any) => {
    const r = await service.handle("GET", "/health", undefined, new URLSearchParams());
    reply.status(r.status).send(r.body);
  }));
  app.all("/diagnostics/logs", wrap(async (req: any, reply: any) => {
    const r = await service.handle("GET", "/diagnostics/logs", undefined, new URLSearchParams(req.query as Record<string, string>));
    reply.status(r.status).send(r.body);
  }));
  await app.listen({ host, port });
  const address = app.server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  return {
    port: actualPort,
    adapter: "fastify",
    service,
    close: async () => { await app.close(); service.close(); },
  };
}

export async function startServer(config: AppConfig): Promise<RunningServer> {
  const store = new DatasetStore(config.dbPath);
  const service = createService(config, store);
  const fastifyServer = await tryFastify(service, config.host, config.port);
  if (fastifyServer) return fastifyServer;
  const { startHttpServer } = await import("./http-server.ts");
  const { server, port } = await startHttpServer(service, config.host, config.port);
  return {
    port,
    adapter: "node:http",
    service,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      service.close();
    },
  };
}
