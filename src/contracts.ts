// Contract layer: shared data shapes and error taxonomy for all modules.

export interface Resources {
  cpu: number;
  memMb: number;
}

export interface NodeInfo extends Resources {
  id: string;
  name: string;
  order: number; // registration order, drives first-fit determinism
}

export interface NamespaceInfo {
  name: string;
  quotaCpu: number;
  quotaMemMb: number;
}

export type WorkloadStatus = 'placed' | 'queued' | 'released' | 'evicted';

export interface Workload {
  id: string;
  namespace: string;
  cpu: number;
  memMb: number;
  nodeId: string | null;
  status: WorkloadStatus;
}

export type ErrorKind =
  | 'VALIDATION'      // malformed input / contract parse failure
  | 'NOT_FOUND'       // referenced entity does not exist
  | 'CONFLICT'        // state conflict, e.g. duplicate namespace name
  | 'QUOTA_EXCEEDED'  // namespace quota insufficient (resource exhaustion)
  | 'INTERNAL';       // unexpected computation failure

export const ERROR_HTTP: Record<ErrorKind, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  QUOTA_EXCEEDED: 422,
  INTERNAL: 500,
};

export interface QuotaDeficit {
  cpu?: number;   // how much cpu is still missing
  memMb?: number; // how much memory is still missing
}

export class KernelError extends Error {
  readonly kind: ErrorKind;
  readonly details?: unknown;
  constructor(kind: ErrorKind, message: string, details?: unknown) {
    super(message);
    this.name = 'KernelError';
    this.kind = kind;
    this.details = details;
  }
  get httpStatus(): number {
    return ERROR_HTTP[this.kind];
  }
}

// Structured log entry: every kernel decision is traceable and replayable.
export interface LogEntry {
  runId: string;
  op: string;
  state: string;   // key intermediate state snapshot
  reason: string;  // why the decision was made
}

export interface OpResult<T> {
  runId: string;
  ok: boolean;
  value?: T;
  error?: { kind: ErrorKind; message: string; details?: unknown };
  logs: LogEntry[];
}

export interface PlacementResult {
  workloadId: string;
  outcome: 'placed' | 'queued';
  nodeId?: string;
}

export interface EvictionRecord {
  workloadId: string;
  nodeId: string | null;
  cpu: number;
  memMb: number;
}

