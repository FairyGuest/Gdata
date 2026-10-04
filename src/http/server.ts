import Fastify, { FastifyInstance } from "fastify";
import { AuditService } from "../service/auditService";
import { AuditError, HTTP_STATUS_BY_CODE } from "../contract/errors";
import { AppendRequest } from "../contract/types";

export function buildServer(service: AuditService): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuditError) {
      reply.status(HTTP_STATUS_BY_CODE[err.code]).send({
        error: {
          code: err.code,
          message: (err as Error).message,
          details: err.details ?? null,
        },
      });
      return;
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    reply.status(status).send({
      error: {
        code: status === 400 ? "INPUT_VALIDATION" : "STORAGE_FAILURE",
        message: (err as Error).message,
        details: null,
      },
    });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/events", async (req) => {
    return service.append(req.body as AppendRequest);
  });

  app.get("/events", async () => ({ entries: service.list() }));

  app.get("/verify", async () => service.verify());

  return app;
}


