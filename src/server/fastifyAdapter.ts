import type { Router } from "./router.ts";
import type { HttpAdapter } from "./httpAdapter.ts";
import { inputError, toServiceError } from "../diagnostics/errors.ts";
import { ERROR_HTTP_STATUS } from "../contract/types.ts";

// Fastify adapter. Only loaded when the fastify package is installed;
// the entry point falls back to NodeHttpAdapter otherwise.
export class FastifyAdapter implements HttpAdapter {
  readonly kind = "fastify";
  private app: any;

  constructor(router: Router, maxPayloadBytes: number, fastifyFactory: any) {
    this.app = fastifyFactory({ bodyLimit: maxPayloadBytes });
    this.app.setErrorHandler((err: unknown, _req: any, reply: any) => {
      const e = toServiceError(err);
      reply.code(ERROR_HTTP_STATUS[e.category]).send({ runId: "n/a", error: { category: e.category, code: e.code, message: e.message } });
    });
    this.app.setNotFoundHandler((_req: any, reply: any) => {
      const e = inputError("NOT_FOUND", "unknown route");
      reply.code(404).send({ runId: "n/a", error: { category: e.category, code: e.code, message: e.message } });
    });
    this.app.get("/health", (_req: any, reply: any) => {
      const r = router.health("health");
      reply.code(r.status).send(r.body);
    });
    this.app.post("/snapshots/compare", (req: any, reply: any) => {
      const r = router.compare(req.body);
      reply.code(r.status).send(r.body);
    });
    this.app.post("/snapshots/create", (req: any, reply: any) => {
      const r = router.create(req.body);
      reply.code(r.status).send(r.body);
    });
    this.app.get("/snapshots/:name", (req: any, reply: any) => {
      const r = router.getSnapshot(req.params.name);
      reply.code(r.status).send(r.body);
    });
  }

  async listen(port: number, host: string): Promise<void> {
    await this.app.listen({ port, host });
  }

  port(): number {
    const addr = this.app.server.address();
    return typeof addr === "object" && addr !== null ? addr.port : 0;
  }

  async close(): Promise<void> {
    await this.app.close();
  }
}
