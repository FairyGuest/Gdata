// Execution kernel: pure lease lifecycle logic. Depends only on the Clock and
// LeaseStore boundaries, so it is testable without HTTP or a real database.
import { randomUUID } from "node:crypto";
import { LeaseError } from "./contract.ts";
import type { HistoryQuery, LeaseRecord, RegisterInput, TableQuery } from "./contract.ts";
import type { Clock } from "./clock.ts";
import type { LeaseStore } from "./store.ts";
import type { LogFn } from "./logger.ts";
import { nullLogger } from "./logger.ts";

export interface KernelOptions {
  portStart: number;
  portEnd: number;
  leaseTtlMs: number;
}

export class LeaseKernel {
  private store: LeaseStore;
  private clock: Clock;
  private opts: KernelOptions;
  private log: LogFn;

  constructor(store: LeaseStore, clock: Clock, opts: KernelOptions, log: LogFn = nullLogger) {
    this.store = store;
    this.clock = clock;
    this.opts = opts;
    this.log = log;
  }

  // Expire every active lease whose deadline is strictly in the past.
  // A lease is still renewable AT expiresAt exactly; it expires one tick later.
  private sweep(): number {
    const now = this.clock.now();
    let expired = 0;
    for (const lease of this.store.listActive()) {
      if (now > lease.expiresAt) {
        lease.status = "expired";
        lease.closedAt = now;
        lease.closeReason = "ttl-expired";
        this.store.update(lease);
        expired++;
        this.log("lease.expired", {
          leaseId: lease.id, port: lease.port, now,
          reason: "now(" + now + ") > expiresAt(" + lease.expiresAt + ")",
        });
      }
    }
    return expired;
  }

  register(input: RegisterInput): LeaseRecord {
    this.sweep();
    const now = this.clock.now();
    let port: number;
    if (input.preferredPort !== undefined) {
      const pref = input.preferredPort;
      if (pref < this.opts.portStart || pref > this.opts.portEnd) {
        throw new LeaseError("INVALID_INPUT", 400,
          "preferredPort " + pref + " is outside the managed range " + this.opts.portStart + ".." + this.opts.portEnd,
          { portStart: this.opts.portStart, portEnd: this.opts.portEnd });
      }
      const occupant = this.store.getActiveByPort(pref);
      if (occupant) {
        this.log("lease.register.conflict", { port: pref, occupantId: occupant.id, reason: "preferred port occupied" });
        throw new LeaseError("PORT_CONFLICT", 409,
          "port " + pref + " is occupied by lease " + occupant.id,
          { port: pref, occupant: { leaseId: occupant.id, target: occupant.target, expiresAt: occupant.expiresAt } });
      }
      port = pref;
    } else {
      const taken = new Set(this.store.listActive().map((l) => l.port));
      port = -1;
      for (let p = this.opts.portStart; p <= this.opts.portEnd; p++) {
        if (!taken.has(p)) { port = p; break; }
      }
      if (port === -1) {
        this.log("lease.register.exhausted", { reason: "no free port in range", portStart: this.opts.portStart, portEnd: this.opts.portEnd });
        throw new LeaseError("RESOURCE_EXHAUSTED", 503,
          "no free port in range " + this.opts.portStart + ".." + this.opts.portEnd,
          { portStart: this.opts.portStart, portEnd: this.opts.portEnd });
      }
    }
    const lease: LeaseRecord = {
      id: randomUUID(),
      target: input.target,
      port,
      status: "active",
      createdAt: now,
      lastHeartbeatAt: now,
      expiresAt: now + this.opts.leaseTtlMs,
      closedAt: null,
      closeReason: null,
    };
    this.store.insert(lease);
    this.log("lease.registered", { leaseId: lease.id, port, target: lease.target, expiresAt: lease.expiresAt, now });
    return lease;
  }

  heartbeat(id: string): LeaseRecord {
    this.sweep();
    const lease = this.mustGet(id);
    if (lease.status === "expired") {
      this.log("lease.heartbeat.rejected", { leaseId: id, reason: "lease already expired", closedAt: lease.closedAt });
      throw new LeaseError("LEASE_EXPIRED", 409, "lease " + id + " expired at " + lease.closedAt, { leaseId: id, status: lease.status, closedAt: lease.closedAt });
    }
    if (lease.status === "released") {
      this.log("lease.heartbeat.rejected", { leaseId: id, reason: "lease explicitly released", closedAt: lease.closedAt });
      throw new LeaseError("LEASE_RELEASED", 409, "lease " + id + " was explicitly released at " + lease.closedAt, { leaseId: id, status: lease.status, closedAt: lease.closedAt });
    }
    const now = this.clock.now();
    lease.lastHeartbeatAt = now;
    lease.expiresAt = now + this.opts.leaseTtlMs;
    this.store.update(lease);
    this.log("lease.renewed", { leaseId: id, port: lease.port, now, expiresAt: lease.expiresAt });
    return lease;
  }

  release(id: string): LeaseRecord {
    this.sweep();
    const lease = this.mustGet(id);
    if (lease.status !== "active") {
      this.log("lease.release.rejected", { leaseId: id, reason: "lease not active", status: lease.status });
      throw new LeaseError("LEASE_NOT_ACTIVE", 409,
        "lease " + id + " is '" + lease.status + "' and cannot be released",
        { leaseId: id, status: lease.status, closedAt: lease.closedAt });
    }
    const now = this.clock.now();
    lease.status = "released";
    lease.closedAt = now;
    lease.closeReason = "explicit-release";
    this.store.update(lease);
    this.log("lease.released", { leaseId: id, port: lease.port, now, reason: "explicit release; port free immediately" });
    return lease;
  }

  forwardingTable(query: TableQuery): LeaseRecord[] {
    this.sweep();
    let rows = this.store.list({ status: query.status });
    if (query.target !== undefined) rows = rows.filter((r) => r.target === query.target);
    return rows;
  }

  history(query: HistoryQuery): LeaseRecord[] {
    this.sweep();
    return this.store.list(query);
  }

  private mustGet(id: string): LeaseRecord {
    const lease = this.store.getById(id);
    if (!lease) {
      throw new LeaseError("LEASE_NOT_FOUND", 404, "no lease with id " + id, { leaseId: id });
    }
    return lease;
  }
}
