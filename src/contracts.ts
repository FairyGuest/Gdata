// Shared data & error contracts between modules.
// Every module speaks these types; errors are always ChaosError with a stable code.

export type FaultType = 'latency' | 'abort' | 'errorStatus' | 'truncate';

export const FAULT_TYPES: readonly FaultType[] = ['latency', 'abort', 'errorStatus', 'truncate'];

export interface FaultParams {
  /** latency: injected delay in ms */
  delayMs?: number;
  /** errorStatus: HTTP status code returned instead of upstream response */
  statusCode?: number;
  /** truncate: fraction of the response body to keep, in (0, 1) */
  keepRatio?: number;
}

export interface FaultConfig {
  /** probability in [0, 1] that a given request is hit by this fault */
  probability: number;
  /** auto-stop after this many ms; 0/undefined = run until manually stopped */
  durationMs?: number;
  params?: FaultParams;
}

export interface ActiveFault extends FaultConfig {
  type: FaultType;
  sessionId: string;
  startedAt: string; // ISO
  stopsAt: string | null; // ISO, null = manual stop only
}

/** One concrete fault application against one request. */
export interface FaultEvent {
  id?: number;
  sessionId: string;
  requestId: string;
  faultType: FaultType;
  /** actual injected quantity: delay ms for latency, kept bytes for truncate, 0 otherwise */
  durationMs: number;
  detail: string;
  timestamp?: string;
}

export interface SessionRow {
  id: string;
  fault_type: FaultType;
  started_at: string;
  ended_at: string | null;
  config_json: string;
}

export type ChaosErrorCode =
  | 'INVALID_CONFIG'      // contract/config parse failure (client input error)
  | 'FAULT_ALREADY_ACTIVE'// state conflict
  | 'FAULT_NOT_ACTIVE'    // state conflict
  | 'NOT_FOUND'           // unknown session/resource
  | 'UPSTREAM_ERROR'      // target service unreachable / failed
  | 'STORE_ERROR'         // persistence failure (resource)
  | 'INTERNAL';           // unexpected computation failure

export class ChaosError extends Error {
  readonly code: ChaosErrorCode;
  readonly httpStatus: number;
  constructor(code: ChaosErrorCode, message: string, httpStatus = 500) {
    super(message);
    this.name = 'ChaosError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
  static invalidConfig(msg: string) { return new ChaosError('INVALID_CONFIG', msg, 400); }
  static conflict(msg: string) { return new ChaosError('FAULT_ALREADY_ACTIVE', msg, 409); }
  static notActive(msg: string) { return new ChaosError('FAULT_NOT_ACTIVE', msg, 409); }
  static notFound(msg: string) { return new ChaosError('NOT_FOUND', msg, 404); }
  static upstream(msg: string) { return new ChaosError('UPSTREAM_ERROR', msg, 502); }
  static store(msg: string) { return new ChaosError('STORE_ERROR', msg, 503); }
}

/** Structured log record: runId + state + reason, replayable. */
export function log(runId: string, level: 'info' | 'warn' | 'error', event: string, data: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), runId, level, event, ...data });
  (level === 'error' ? console.error : console.log)(line);
}
