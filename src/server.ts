// HTTP boundary (Fastify). Translates HTTP <-> contract types and maps the
// kernel's LeaseError taxonomy onto status codes. No business rules live here.
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { LeaseError, parseAdvanceBody, parseHistoryQuery, parseRegisterBody, parseTableQuery } from "./contract.ts";
import type { ServiceConfig } from "./config.ts";
import { LeaseKernel } from "./kernel.ts";
import type { Clock } from "./clock.ts";
import { SystemClock, VirtualClock } from "./clock.ts";
import { SqliteLeaseStore } from "./store.ts";
import type { LeaseStore } from "./store.ts";
import { makeLogger } from "./logger.ts";
import type { LogFn } from "./logger.ts";

export interface BuiltServer {
  app: FastifyInstance;
  kernel: LeaseKernel;
  store: LeaseStore;
  clock: Clock;
}

export function buildServer(config: ServiceConfig, deps: { clock?: Clock; store?: LeaseStore; log?: LogFn } = {}): BuiltServer {
  const log = deps.log ?? makeLogger(config.runId);
  const clock = deps.clock ?? (config.clockMode === "virtual" ? new VirtualClock(config.virtualStartMs) : new SystemClock());
  const store = deps.store ?? new SqliteLeaseStore(config.dbPath);
  const kernel = new LeaseKernel(store, clock, {
    portStart: config.portStart,
    portEnd: config.portEnd,
    leaseTtlMs: config.leaseTtlMs,
  }, log);

  const app = Fastify({ logger: false });

  app.setErrorHandler((err, req, reply) => {
    const fastifyStatus = (err as { statusCode?: number }).statusCode;
    if (typeof fastifyStatus === "number" && fastifyStatus >= 400 && fastifyStatus < 500) {
      log("request.error", { requestId: req.id, code: "INVALID_INPUT", message: String(err), url: req.url });
      reply.status(fastifyStatus).send({ error: { code: "INVALID_INPUT", message: "malformed HTTP request: " + (err as Error).message, details: null } });
      return;
    }
    if (err instanceof LeaseError) {
      log("request.error", { requestId: req.id, code: err.code, message: err.message, url: req.url });
      reply.status(err.httpStatus).send({ error: { code: err.code, message: err.message, details: err.details ?? null } });
      return;
    }
    log("request.error", { requestId: req.id, code: "INTERNAL", message: String(err), url: req.url });
    reply.status(500).send({ error: { code: "INTERNAL", message: "unexpected internal failure", details: null } });
  });

  app.post("/leases", async (req, reply) => {
    const input = parseRegisterBody(req.body);
    const lease = kernel.register(input);
    reply.status(201).send({ lease });
  });

  app.post("/leases/:id/heartbeat", async (req) => {
    const id = (req.params as { id: string }).id;
    return { lease: kernel.heartbeat(id) };
  });

  const releaseHandler = async (req: unknown) => {
    const id = ((req as { params: { id: string } }).params).id;
    return { lease: kernel.release(id) };
  };
  app.post("/leases/:id/release", releaseHandler);
  app.delete("/leases/:id", releaseHandler);

  app.get("/forwarding-table", async (req) => {
    const query = parseTableQuery(req.query);
    return { entries: kernel.forwardingTable(query) };
  });

  app.get("/leases", async (req) => {
    const query = parseHistoryQuery(req.query);
    return { leases: kernel.history(query) };
  });

  app.get("/diagnostics", async () => ({
    runId: config.runId,
    clockMode: config.clockMode,
    now: clock.now(),
    portRange: { start: config.portStart, end: config.portEnd },
    leaseTtlMs: config.leaseTtlMs,
    counts: store.countByStatus(),
  }));

  app.post("/diagnostics/clock/advance", async (req) => {
    if (!(clock instanceof VirtualClock)) {
      throw new LeaseError("CLOCK_FORBIDDEN", 403, "clock advance requires TUNNEL_CLOCK=virtual");
    }
    const { ms } = parseAdvanceBody(req.body);
    const now = clock.advance(ms);
    log("clock.advanced", { ms, now });
    return { now };
  });

  return { app, kernel, store, clock };
}

