import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.ts";
import { parseConsume, parseProvision, parseRotate } from "./contract.ts";
import { toErrorBody } from "./errors.ts";
import type { QuotaKernel } from "./kernel.ts";

/**
 * Diagnostic HTTP interface. Thin adapter: parse contract -> call kernel ->
 * map result/error onto the shared error contract.
 */
export function buildServer(kernel: QuotaKernel, config: AppConfig): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = toErrorBody(err);
    reply.status(status).send(body);
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/keys", async (req) => {
    const input = parseProvision(req.body);
    kernel.provisionKey(input);
    return { key: input.key, provisioned: true };
  });

  app.post("/quota/consume", async (req) => {
    const { key, amount } = parseConsume(req.body);
    return kernel.consume(key, amount);
  });

  app.post("/keys/rotate", async (req) => {
    const { key, graceMs } = parseRotate(req.body, config.defaultGraceMs);
    return kernel.rotate(key, graceMs);
  });

  app.get("/keys/:key/usage", async (req) => {
    const { key } = req.params as { key: string };
    return kernel.usage(key);
  });

  return app;
}
