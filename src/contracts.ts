// Contract layer: shapes exchanged between HTTP, kernel and store, plus
// parsing/validation of external input. Invalid input fails here with
// INPUT_ERROR before touching the kernel.

import { inputError } from "./errors.ts";

export type LeaseStatus = "active" | "expired" | "released";
export const LEASE_STATUSES: ReadonlyArray<LeaseStatus> = ["active", "expired", "released"];

export interface Lease {
  leaseId: string;
  target: string;            // tunnel target address, e.g. "127.0.0.1:5432"
  port: number;              // allocated public port
  status: LeaseStatus;
  createdAt: number;
  lastHeartbeatAt: number;   // registration counts as the first heartbeat
  expiresAt: number;         // always === lastHeartbeatAt + leaseTtlMs
  closedAt: number | null;   // set when the lease reaches a terminal state
}

export interface RegisterRequest {
  target: string;
  preferredPort?: number;
}

export interface ForwardTableEntry {
  leaseId: string;
  target: string;
  port: number;
  status: LeaseStatus;
  expiresAt: number;
}

export interface ForwardTableFilter {
  target?: string;
  status?: LeaseStatus;
}

export interface LeaseHistoryFilter {
  port?: number;
  status?: LeaseStatus;
}

export function parseRegisterBody(body: unknown): RegisterRequest {
  if (typeof body !== "object" || body === null) {
    throw inputError("request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.target !== "string" || b.target.trim() === "") {
    throw inputError("field 'target' must be a non-empty string", { field: "target" });
  }
  const out: RegisterRequest = { target: b.target };
  if (b.preferredPort !== undefined && b.preferredPort !== null) {
    if (typeof b.preferredPort !== "number" || !Number.isInteger(b.preferredPort)) {
      throw inputError("field 'preferredPort' must be an integer", { field: "preferredPort" });
    }
    out.preferredPort = b.preferredPort;
  }
  return out;
}

export function parseLeaseId(params: Record<string, string>): string {
  const id = params.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw inputError("lease id path parameter is required");
  }
  return id;
}

export function parseStatusFilter(value: string | undefined): LeaseStatus | undefined {
  if (value === undefined) return undefined;
  if ((LEASE_STATUSES as ReadonlyArray<string>).includes(value)) return value as LeaseStatus;
  throw inputError("invalid status filter", { value, allowed: LEASE_STATUSES });
}

export function parsePortFilter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw inputError("invalid port filter", { value });
  return n;
}

