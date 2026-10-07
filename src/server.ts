// HTTP layer (Fastify-compatible). Translates HTTP <-> kernel calls and maps
// the error taxonomy to status codes. No business logic lives here.

import fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { LeaseKernel } from "./kernel.ts";
import {
  parseRegisterBody, parseLeaseId, parseStatusFilter, parsePortFilter,
} from "./contracts.ts";
import { toErrorBody } from "./errors.ts";

export function buildServer(kernel: LeaseKernel): FastifyInstance {
  const app = fastify();

  const guard = (reply: { code(n: number): unknown; send(p: unknown): unknown }, fn: () => unknown) => {
    try {
      return fn();
    } catch (err) {
      const { httpStatus, body } = toErrorBody(err);
      return (reply.code(httpStatus) as { send(p: unknown): unknown }).send(body);
    }
  };

  app.post("/tunnels", (req, reply) => guard(reply, () => {
    const body = parseRegisterBody(req.body);
    const lease = kernel.register(body);
    return (reply.code(201) as { send(p: unknown): unknown }).send({ lease });
  }));

  app.post("/tunnels/:id/heartbeat", (req, reply) => guard(reply, () => {
    const lease = kernel.heartbeat(parseLeaseId(req.params));
    return { lease };
  }));

  app.post("/tunnels/:id/release", (req, reply) => guard(reply, () => {
    const lease = kernel.release(parseLeaseId(req.params));
    return { lease };
  }));

  app.get("/forward-table", (req, reply) => guard(reply, () => {
    const entries = kernel.forwardTable({
      target: req.query.target,
      status: parseStatusFilter(req.query.status),
    });
    return { entries };
  }));

  app.get("/leases", (req, reply) => guard(reply, () => {
    const leases = kernel.history({
      port: parsePortFilter(req.query.port),
      status: parseStatusFilter(req.query.status),
    });
    return { leases };
  }));

  app.get("/diagnostics/state", (req, reply) => guard(reply, () => kernel.diagnostics()));

  return app;
}

