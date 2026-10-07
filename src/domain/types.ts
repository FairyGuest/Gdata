/** Shared data & error contracts between contract parsing, core engine, state adapter and HTTP layer. */

export interface Resources {
  cpu: number;
  memoryMb: number;
}

export interface NodeInfo {
  id: string;
  capacity: Resources;
  used: Resources;
  /** registration order, drives first-fit determinism */
  seq: number;
}

export interface NamespaceInfo {
  name: string;
  quota: Resources;
  used: Resources;
}

export type WorkloadStatus = "running" | "queued" | "evicted";

export interface Workload {
  id: string;
  namespace: string;
  request: Resources;
  status: WorkloadStatus;
  nodeId: string | null;
  createdSeq: number;
}

export type ErrorKind =
  | "VALIDATION" // malformed input / contract parse failure
  | "CONFLICT" // state conflict, e.g. duplicate namespace
  | "NOT_FOUND" // referenced entity does not exist
  | "QUOTA_EXCEEDED" // namespace quota insufficient
  | "NO_CAPACITY"; // no node fits right now (workload queued)

export class ServiceError extends Error {
  constructor(
    public kind: ErrorKind,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface QuotaShortfall {
  cpu: number;
  memoryMb: number;
}
