// Execution kernel: fires exactly config.totalRequests HTTP attempts with a
// bounded worker pool. Every attempt produces exactly one RequestResult;
// results are never dropped, regardless of success or failure.

import { performance } from "node:perf_hooks";
import type { RequestResult, RunConfig } from "./types.ts";

export interface EngineEvents {
  onResult?: (r: RequestResult) => void;
  onLog?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function attempt(config: RunConfig, seq: number): Promise<RequestResult> {
  const started = performance.now();
  let statusCode: number | null = null;
  try {
    const res = await fetch(config.targetUrl, {
      method: "GET",
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: "manual",
    });
    // Drain the body so the socket can be reused / closed cleanly.
    await res.arrayBuffer().catch(() => {});
    statusCode = res.status;
    const latencyMs = performance.now() - started;
    if (res.status >= 200 && res.status < 300) {
      return { seq, latencyMs, statusCode, outcome: "success", failureKind: null, errorMessage: null };
    }
    return {
      seq, latencyMs, statusCode, outcome: "failure", failureKind: "http_error",
      errorMessage: `non-2xx status: ${res.status}`,
    };
  } catch (err) {
    const latencyMs = performance.now() - started;
    const name = (err as { name?: string })?.name ?? "";
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = name === "TimeoutError" || name === "AbortError" || /timed?\s*out/i.test(message);
    return {
      seq, latencyMs, statusCode, outcome: "failure",
      failureKind: isTimeout ? "timeout" : "network_error",
      errorMessage: message,
    };
  }
}

export async function executeRun(config: RunConfig, events: EngineEvents = {}): Promise<RequestResult[]> {
  const workerCount = Math.min(config.concurrency, config.totalRequests);
  events.onLog?.(`engine: starting ${config.totalRequests} requests with ${workerCount} workers, interval=${config.requestIntervalMs}ms, timeout=${config.timeoutMs}ms`);
  const results: RequestResult[] = new Array(config.totalRequests);
  let next = 0;

  async function worker(id: number): Promise<void> {
    let first = true;
    while (true) {
      const seq = next++;
      if (seq >= config.totalRequests) return;
      if (!first && config.requestIntervalMs > 0) await sleep(config.requestIntervalMs);
      first = false;
      const r = await attempt(config, seq);
      results[seq] = r;
      events.onResult?.(r);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
  // Defensive check: the contract says no result may be lost.
  for (let i = 0; i < results.length; i++) {
    if (!results[i]) {
      throw new Error(`engine invariant violated: missing result for seq=${i}`);
    }
  }
  events.onLog?.(`engine: completed ${results.length} requests`);
  return results;
}
