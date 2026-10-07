// Contract layer: shared data shapes, error taxonomy, and input parsing.
// Every cross-module failure is a LeaseError with a stable, machine-readable code.

export type LeaseStatus = "active" | "expired" | "released";

export type ErrorCode =
  | "INVALID_INPUT"      // 400 malformed request payload / query
  | "LEASE_NOT_FOUND"    // 404 unknown tunnel id
  | "PORT_CONFLICT"      // 409 preferred port occupied by another active lease
  | "LEASE_EXPIRED"      // 409 operation on a lease that hit its TTL
  | "LEASE_RELEASED"     // 409 operation on an explicitly released lease
  | "LEASE_NOT_ACTIVE"   // 409 release of a lease already in a terminal state
  | "RESOURCE_EXHAUSTED" // 503 no free port in the configured range
  | "CLOCK_FORBIDDEN"    // 403 clock advance attempted under the system clock
  | "INTERNAL";          // 500 unexpected computation failure

export class LeaseError extends Error {
  code: ErrorCode;
  httpStatus: number;
  details: unknown;
  constructor(code: ErrorCode, httpStatus: number, message: string, details?: unknown) {
    super(message);
    this.name = "LeaseError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export interface LeaseRecord {
  id: string;
  target: string;
  port: number;
  status: LeaseStatus;
  createdAt: number;
  lastHeartbeatAt: number;
  expiresAt: number;
  closedAt: number | null;
  closeReason: "ttl-expired" | "explicit-release" | null;
}

export interface RegisterInput {
  target: string;
  preferredPort?: number;
}

export interface TableQuery {
  target?: string;
  status?: LeaseStatus;
}

export interface HistoryQuery {
  port?: number;
  status?: LeaseStatus;
}

const STATUSES: LeaseStatus[] = ["active", "expired", "released"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseStatus(v: unknown, field: string): LeaseStatus {
  if (typeof v === "string" && (STATUSES as string[]).includes(v)) return v as LeaseStatus;
  throw new LeaseError("INVALID_INPUT", 400, "field '" + field + "' must be one of " + STATUSES.join("|"), { value: v });
}

export function parseRegisterBody(body: unknown): RegisterInput {
  if (!isRecord(body)) {
    throw new LeaseError("INVALID_INPUT", 400, "request body must be a JSON object");
  }
  const target = body.target;
  if (typeof target !== "string" || target.trim().length === 0 || target.length > 512) {
    throw new LeaseError("INVALID_INPUT", 400, "field 'target' must be a non-empty string of at most 512 chars", { value: target });
  }
  const out: RegisterInput = { target };
  if (body.preferredPort !== undefined && body.preferredPort !== null) {
    const p = body.preferredPort;
    if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535) {
      throw new LeaseError("INVALID_INPUT", 400, "field 'preferredPort' must be an integer in 1..65535", { value: p });
    }
    out.preferredPort = p;
  }
  return out;
}

export function parseTableQuery(query: unknown): TableQuery {
  const out: TableQuery = {};
  if (!isRecord(query)) return out;
  if (typeof query.target === "string" && query.target.length > 0) out.target = query.target;
  if (query.status !== undefined) out.status = parseStatus(query.status, "status");
  return out;
}

export function parseHistoryQuery(query: unknown): HistoryQuery {
  const out: HistoryQuery = {};
  if (!isRecord(query)) return out;
  if (query.port !== undefined) {
    const n = Number(query.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new LeaseError("INVALID_INPUT", 400, "query 'port' must be an integer in 1..65535", { value: query.port });
    }
    out.port = n;
  }
  if (query.status !== undefined) out.status = parseStatus(query.status, "status");
  return out;
}

export function parseAdvanceBody(body: unknown): { ms: number } {
  if (!isRecord(body) || typeof body.ms !== "number" || !Number.isFinite(body.ms) || body.ms <= 0) {
    throw new LeaseError("INVALID_INPUT", 400, "field 'ms' must be a positive finite number", { value: isRecord(body) ? body.ms : body });
  }
  return { ms: body.ms };
}
