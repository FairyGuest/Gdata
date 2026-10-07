import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { isAppError } from "../domain/errors.ts";
import type { ScopeType } from "../domain/types.ts";
import { BindingService } from "../service/service.ts";

export function buildServer(service: BindingService): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (req, reply) => {
    const runId = randomUUID();
    (req as unknown as { runId: string }).runId = runId;
    reply.header("x-run-id", runId);
  });

  app.setErrorHandler((err, req, reply) => {
    const runId = (req as unknown as { runId?: string }).runId;
    if (isAppError(err)) {
      return reply
        .status(err.httpStatus)
        .send({ error: { code: err.code, message: err.message, details: err.details ?? null, runId } });
    }
    const fastifyErr = err as Error & { statusCode?: number };
    const status = typeof fastifyErr.statusCode === "number" ? fastifyErr.statusCode : 500;
    const code = status >= 500 ? "INTERNAL_ERROR" : "VALIDATION_ERROR";
    return reply
      .status(status)
      .send({ error: { code, message: fastifyErr.message, details: null, runId } });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.put("/scopes/:scopeType/:scopeId/secrets/:name", async (req) => {
    const { scopeType, scopeId, name } = req.params as { scopeType: ScopeType; scopeId: string; name: string };
    const body = (req.body ?? {}) as { value?: string };
    const decl = service.declareSecret(
      { scopeType, scopeId, name, value: body.value ?? "" },
      (req as unknown as { runId: string }).runId,
    );
    return {
      id: decl.id,
      scopeType: decl.scopeType,
      scopeId: decl.scopeId,
      name: decl.name,
      version: decl.version,
    };
  });

  app.delete("/scopes/:scopeType/:scopeId/secrets/:name", async (req, reply) => {
    const { scopeType, scopeId, name } = req.params as { scopeType: ScopeType; scopeId: string; name: string };
    service.deleteDeclaration(scopeType, scopeId, name, (req as unknown as { runId: string }).runId);
    return reply.status(204).send();
  });

  app.post("/environments", async (req, reply) => {
    const body = (req.body ?? {}) as {
      orgId?: string;
      projectId?: string;
      name?: string;
      requiredSecrets?: string[]; id?: string;
    };
    const result = service.createEnvironment(
      {
        id: body.id,
        orgId: body.orgId ?? "",
        projectId: body.projectId ?? "",
        name: body.name ?? "",
        requiredSecrets: body.requiredSecrets ?? [],
      },
      (req as unknown as { runId: string }).runId,
    );
    return reply.status(201).send({
      environment: result.environment,
      resolved: result.resolved.map((r) => ({
        name: r.name,
        level: r.level,
        sourcePath: r.sourcePath,
        declarationVersion: r.declarationVersion,
        fingerprint: r.fingerprint,
      })),
    });
  });

  app.get("/environments/:envId/secrets", async (req) => {
    const { envId } = req.params as { envId: string };
    return { envId, secrets: service.getEnvironmentSecrets(envId) };
  });

  app.delete("/environments/:envId", async (req, reply) => {
    const { envId } = req.params as { envId: string };
    service.deleteEnvironment(envId, (req as unknown as { runId: string }).runId);
    return reply.status(204).send();
  });

  app.get("/bindings", async (req) => {
    const q = req.query as { envId?: string; name?: string };
    return { bindings: service.queryBindings({ envId: q.envId, name: q.name }) };
  });

  return app;
}
