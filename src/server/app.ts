import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { RbacError, categoryToStatus } from "../contract/errors.ts";
import {
  parseCheckRequest,
  parsePolicyDocument,
  parseRoleEdge,
  parseRoleName,
  parseRule,
} from "../contract/validate.ts";
import { decide } from "../kernel/engine.ts";
import type { PolicyStore } from "../state/store.ts";

export interface BuildOptions {
  store: PolicyStore;
  logger?: boolean;
}

export function buildApp({ store, logger = true }: BuildOptions): FastifyInstance {
  const app = Fastify({
    logger: logger ? { level: "info" } : false,
    genReqId: () => randomUUID(),
  });

  app.setErrorHandler((err, req, reply) => {
    const fastifyCode = (err as { code?: string }).code ?? "";
    if (fastifyCode.startsWith("FST_ERR_CTP") || fastifyCode === "FST_ERR_VALIDATION") {
      req.log.warn({ err: { code: fastifyCode } }, "malformed request body");
      return reply.status(400).send({
        error: { code: "MALFORMED_BODY", category: "input", message: (err as Error).message },
      });
    }
    if (err instanceof RbacError) {
      req.log.warn({ err: { code: err.code, category: err.category } }, "request failed");
      return reply.status(categoryToStatus(err.category)).send({
        error: { code: err.code, category: err.category, message: (err as Error).message },
      });
    }
    req.log.error({ err }, "unexpected failure");
    return reply.status(500).send({
      error: { code: "INTERNAL", category: "internal", message: "unexpected internal error" },
    });
  });

  app.post("/check", async (req, reply) => {
    const checkReq = parseCheckRequest(req.body);
    const snapshot = store.getSnapshot();
    const decision = decide(snapshot, checkReq);
    req.log.info(
      {
        runId: req.id,
        policyVersion: decision.policyVersion,
        request: checkReq,
        effectiveRoles: decision.effectiveRoles,
        matchedRules: decision.matchedRules,
        decision: decision.allow,
        reason: decision.reason,
      },
      "authorization decision",
    );
    return reply.send({ runId: req.id, ...decision });
  });

  app.put("/policy", async (req, reply) => {
    const doc = parsePolicyDocument(req.body);
    const version = store.replacePolicy(doc);
    req.log.info({ runId: req.id, policyVersion: version }, "policy replaced");
    return reply.send({ ok: true, version });
  });

  app.post("/policy/roles", async (req, reply) => {
    const name = parseRoleName(req.body);
    const version = store.addRole(name);
    return reply.status(201).send({ ok: true, version });
  });

  app.delete("/policy/roles/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const version = store.deleteRole(name);
    return reply.send({ ok: true, version });
  });

  app.post("/policy/edges", async (req, reply) => {
    const edge = parseRoleEdge(req.body);
    const version = store.addRoleEdge(edge);
    return reply.status(201).send({ ok: true, version });
  });

  app.post("/policy/rules", async (req, reply) => {
    const rule = parseRule(req.body);
    const { id, version } = store.addRule(rule);
    return reply.status(201).send({ ok: true, id, version });
  });

  app.delete("/policy/rules/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({
        error: { code: "INVALID_ID", category: "input", message: "rule id must be a positive integer" },
      });
    }
    const version = store.deleteRule(id);
    return reply.send({ ok: true, version });
  });

  app.get("/diagnostics/state", async () => {
    const snapshot = store.getSnapshot();
    return {
      version: snapshot.version,
      roles: snapshot.roles.size,
      rules: snapshot.rules.length,
    };
  });

  app.get("/diagnostics/health", async () => ({ status: "ok" }));

  return app;
}
