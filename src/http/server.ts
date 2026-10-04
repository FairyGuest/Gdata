import Fastify, { FastifyInstance } from "fastify";
import { eventInputSchema } from "../contract/schema";
import { AuditEventInput, GENESIS_HASH } from "../contract/types";
import { isAuditError } from "../contract/errors";
import { verifyChain } from "../core/chain";
import { AuditStore } from "../state/store";

export function buildServer(store: AuditStore): FastifyInstance {
  const app = Fastify({ logger: true });

  app.setErrorHandler((err, request, reply) => {
    if (isAuditError(err)) {
      return reply
        .code(err.statusCode)
        .send({ error: { kind: err.kind, message: err.message, details: err.details ?? null } });
    }
    const anyErr = err as { statusCode?: number; validation?: unknown };
    if (anyErr.statusCode === 400 && anyErr.validation) {
      return reply.code(400).send({
        error: { kind: "VALIDATION", message: err.message, details: null },
      });
    }
    request.log.error(err);
    return reply
      .code(500)
      .send({ error: { kind: "INTERNAL", message: "unexpected internal error", details: null } });
  });

  app.post(
    "/events",
    { schema: { body: eventInputSchema } },
    async (request, reply) => {
      const event = store.append(request.body as AuditEventInput);
      return reply.code(201).send(event);
    }
  );

  app.get(
    "/events",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request) => {
      const { limit, offset } = request.query as {
        limit?: number;
        offset?: number;
      };
      return { events: store.list(limit ?? 100, offset ?? 0) };
    }
  );

  app.get("/verify", async () => verifyChain(store.all()));

  app.get("/diagnostics", async () => ({
    status: "ok",
    count: store.count(),
    head: store.head(),
    genesisHash: GENESIS_HASH,
  }));

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
