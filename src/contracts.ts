// Shared data & error contracts between modules.
// Every cross-module boundary uses these types; errors carry a machine-readable
// code so callers can distinguish input errors, state conflicts, resource
// exhaustion and computation failures.

export type FailureKind = 'http_status' | 'timeout' | 'connection';

export interface RunConfig {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  requests: number;
  concurrency: number;
  intervalMs: number;
  timeoutMs: number;
}

export interface RequestOutcome {
  seq: number;
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  failureKind: FailureKind | null;
  error: string | null;
}

export interface LatencyStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

export interface RunResult {
  config: RunConfig;
  startedAt: string;
  durationMs: number;
  total: number;
  succeeded: number;
  failed: number;
  failuresByKind: Record<FailureKind, number>;
  statusCodes: Record<string, number>;
  throughputRps: number;
  successLatency: LatencyStats;
  failureLatency: LatencyStats;
  outcomes: RequestOutcome[];
}

export type ErrorCode =
  | 'INPUT_ERROR'
  | 'NOT_FOUND'
  | 'STATE_CONFLICT'
  | 'RESOURCE_EXHAUSTED'
  | 'COMPUTATION_FAILURE'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string, httpStatus: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export const inputError = (msg: string) => new AppError('INPUT_ERROR', msg, 400);
export const notFound = (msg: string) => new AppError('NOT_FOUND', msg, 404);
export const stateConflict = (msg: string) => new AppError('STATE_CONFLICT', msg, 409);
export const resourceExhausted = (msg: string) => new AppError('RESOURCE_EXHAUSTED', msg, 503);
export const computationFailure = (msg: string) => new AppError('COMPUTATION_FAILURE', msg, 500);
