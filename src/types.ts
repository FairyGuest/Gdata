// Data contracts shared across all modules. Single source of truth for
// the shapes exchanged between contract parsing, engine, store and HTTP layer.

export type FailureKind = "http_error" | "timeout" | "network_error";

export type Outcome = "success" | "failure";

export interface RequestResult {
  seq: number;            // 0-based global request index inside the run
  latencyMs: number;      // wall-clock latency of the single attempt
  statusCode: number | null; // null when no HTTP response was received
  outcome: Outcome;
  failureKind: FailureKind | null; // null iff outcome === "success"
  errorMessage: string | null;
}

export interface RunConfig {
  targetUrl: string;
  concurrency: number;     // >= 1
  totalRequests: number;   // >= 1
  requestIntervalMs: number; // >= 0, per-worker delay between requests
  timeoutMs: number;       // >= 1, per-request timeout
}

export interface StatsBlock {
  count: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
}

export interface RunSummary {
  runId: string;
  targetUrl: string;
  config: RunConfig;
  startedAt: string; // ISO
  finishedAt: string; // ISO
  durationMs: number;
  totalRequests: number;
  successCount: number;
  failureCount: number;
  failuresByKind: Record<FailureKind, number>;
  throughputRps: number; // totalRequests / durationSeconds
  successStats: StatsBlock | null; // null when no successful request
  failureStats: StatsBlock | null; // null when no failed request
}

export type RunStatus = "running" | "completed" | "failed";

export interface RunRecord {
  runId: string;
  targetUrl: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  config: RunConfig;
  summary: RunSummary | null;
  error: { code: string; message: string } | null;
}
