// Execution kernel: pure lease lifecycle logic driven by an injected Clock.
// Owns allocation, heartbeat renewal, explicit release and lazy expiry.
// Every operation runs under a run id and appends structured log entries
// recording key intermediate states and the reason for each decision.

import type { Clock } from "./clock.ts";
import type { ServiceConfig } from "./config.ts";
import type { Lease, ForwardTableEntry, ForwardTableFilter, RegisterRequest } from "./contracts.ts";
import type { LeaseStore } from "./store.ts";
import {
  AppError, inputError, portConflict, leaseNotFound, leaseNotActive, resourceExhausted, internalError,
} from "./errors.ts";

export interface LogEntry {
  runId: string;
  at: number;
  event: string;
  detail: Record<string, unknown>;
}

export interface KernelDeps {
  clock: Clock;
  store: LeaseStore;
  config: Pick<ServiceConfig, "portMin" | "portMax" | "leaseTtlMs">;
  idGen?: () => string;
  logCapacity?: number;
}

export class LeaseKernel {
  private clock: Clock;
  private store: LeaseStore;
  private cfg: Pick<ServiceConfig, "portMin" | "portMax" | "leaseTtlMs">;
  private idGen: () => string;
  private logs: LogEntry[] = [];
  private logCapacity: number;
  private opCounter = 0;

  constructor(deps: KernelDeps) {
    this.clock = deps.clock;
    this.store = deps.store;
    this.cfg = deps.config;
    this.idGen = deps.idGen ?? (() => "lease-" + Math.random().toString(36).slice(2, 10));
    this.logCapacity = deps.logCapacity ?? 500;
  }

  private log(runId: string, event: string, detail: Record<string, unknown>): void {
    this.logs.push({ runId, at: this.clock.now(), event, detail });
    if (this.logs.length > this.logCapacity) this.logs.splice(0, this.logs.length - this.logCapacity);
  }

  recentLogs(limit = 100): LogEntry[] { return this.logs.slice(-limit); }

  // Lazily expire every active lease whose deadline is strictly in the past.
  // A lease with expiresAt === now is still renewable (boundary rule).
  private sweep(runId: string): Lease[] {
    const now = this.clock.now();
    const expired: Lease[] = [];
    for (const lease of this.store.listActive()) {
      if (lease.expiresAt < now) {
        lease.status = "expired";
        lease.closedAt = now;
        this.store.update(lease);
        expired.push(lease);
        this.log(runId, "lease.expired", {
          leaseId: lease.leaseId, port: lease.port, expiresAt: lease.expiresAt, now,
          reason: "expiresAt < now at sweep; port released for reuse",
        });
      }
    }
    return expired;
  }

  private beginOp(op: string): string {
    this.opCounter += 1;
    const runId = "op-" + this.opCounter + "-" + op;
    this.sweep(runId);
    return runId;
  }

  private fail(runId: string, err: AppError): never {
    err.runId = runId;
    this.log(runId, "op.rejected", { code: err.code, message: err.message, details: err.details ?? null });
    throw err;
  }

  register(req: RegisterRequest): Lease {
    const runId = this.beginOp("register");
    const now = this.clock.now();
    const range = { portMin: this.cfg.portMin, portMax: this.cfg.portMax };
    let port: number;
    if (req.preferredPort !== undefined) {
      const p = req.preferredPort;
      if (p < range.portMin || p > range.portMax) {
        this.fail(runId, inputError("preferredPort outside allocatable range", { preferredPort: p, ...range }));
      }
      const occupant = this.store.activeByPort(p);
      if (occupant) {
        this.fail(runId, portConflict("preferred port " + p + " is occupied", {
          port: p,
          occupant: { leaseId: occupant.leaseId, target: occupant.target, expiresAt: occupant.expiresAt },
        }));
      }
      port = p;
      this.log(runId, "port.allocated", { port, mode: "preferred", reason: "preferred port was free" });
    } else {
      const used = new Set(this.store.listActive().map((l) => l.port));
      let found = -1;
      for (let p = range.portMin; p <= range.portMax; p++) {
        if (!used.has(p)) { found = p; break; }
      }
      if (found === -1) {
        this.fail(runId, resourceExhausted("no free port in range", range));
      }
      port = found;
      this.log(runId, "port.allocated", { port, mode: "auto", reason: "smallest free port in range" });
    }
    const lease: Lease = {
      leaseId: this.idGen(),
      target: req.target,
      port,
      status: "active",
      createdAt: now,
      lastHeartbeatAt: now,
      expiresAt: now + this.cfg.leaseTtlMs,
      closedAt: null,
    };
    try {
      this.store.insert(lease);
    } catch (err) {
      this.fail(runId, err instanceof AppError ? err : internalError("persist lease failed", String(err)));
    }
    this.log(runId, "lease.registered", { leaseId: lease.leaseId, target: lease.target, port, expiresAt: lease.expiresAt });
    return lease;
  }

  heartbeat(leaseId: string): Lease {
    const runId = this.beginOp("heartbeat");
    const now = this.clock.now();
    const lease = this.store.getById(leaseId);
    if (!lease) this.fail(runId, leaseNotFound(leaseId));
    if (lease!.status !== "active") {
      this.fail(runId, leaseNotActive(leaseId, lease!.status));
    }
    // Boundary rule: heartbeat exactly at expiresAt still succeeds.
    lease!.lastHeartbeatAt = now;
    lease!.expiresAt = now + this.cfg.leaseTtlMs;
    this.store.update(lease!);
    this.log(runId, "lease.renewed", {
      leaseId, port: lease!.port, lastHeartbeatAt: now, expiresAt: lease!.expiresAt,
      reason: "heartbeat at or before deadline extends expiry by leaseTtlMs",
    });
    return lease!;
  }

  release(leaseId: string): Lease {
    const runId = this.beginOp("release");
    const now = this.clock.now();
    const lease = this.store.getById(leaseId);
    if (!lease) this.fail(runId, leaseNotFound(leaseId));
    if (lease!.status !== "active") {
      this.fail(runId, leaseNotActive(leaseId, lease!.status));
    }
    lease!.status = "released";
    lease!.closedAt = now;
    this.store.update(lease!);
    this.log(runId, "lease.released", {
      leaseId, port: lease!.port, reason: "explicit release; port immediately reusable",
    });
    return lease!;
  }

  forwardTable(filter: ForwardTableFilter = {}): ForwardTableEntry[] {
    const runId = this.beginOp("forward-table");
    const entries = this.store.query({ status: filter.status })
      .filter((l) => filter.target === undefined || l.target === filter.target)
      .map((l) => ({ leaseId: l.leaseId, target: l.target, port: l.port, status: l.status, expiresAt: l.expiresAt }));
    this.log(runId, "forward-table.query", { filter, count: entries.length });
    return entries;
  }

  history(filter: { port?: number; status?: Lease["status"] } = {}): Lease[] {
    const runId = this.beginOp("history");
    const rows = this.store.query(filter);
    this.log(runId, "history.query", { filter, count: rows.length });
    return rows;
  }

  diagnostics() {
    return {
      now: this.clock.now(),
      config: this.cfg,
      leases: this.store.all(),
      recentLogs: this.recentLogs(50),
    };
  }
}

