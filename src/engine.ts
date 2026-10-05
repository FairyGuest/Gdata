// Execution kernel: issues HTTP requests with bounded concurrency and pacing,
// records EVERY request outcome (no result is ever dropped), classifies
// failures, and computes latency stats separately for successes and failures.
import {
  computationFailure,
  type FailureKind,
  type RequestOutcome,
  type RunConfig,
  type RunResult,
} from './contracts.ts';
import { summarize } from './stats.ts';

export type RunLogger = (event: string, fields: Record<string, unknown>) => void;

const noopLog: RunLogger = () => {};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyError(err: unknown): { kind: FailureKind; message: string } {
  const name = (err as { name?: string })?.name ?? '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'TimeoutError' || name === 'AbortError' || /timed? ?out/i.test(message)) {
    return { kind: 'timeout', message };
  }
  return { kind: 'connection', message };
}

export async function runLoadTest(
  config: RunConfig,
  log: RunLogger = noopLog,
): Promise<RunResult> {
  const runTag = 'requests=' + config.requests + ' concurrency=' + config.concurrency;
  log('run.start', { config: runTag, url: config.url });

  // outcomes is pre-allocated and indexed by sequence number so that no
  // request result can be lost regardless of completion order.
  const outcomes: RequestOutcome[] = new Array(config.requests);
  let next = 0;
  const startMs = Date.now();
  const startedAt = new Date(startMs).toISOString();

  async function worker(workerId: number): Promise<void> {
    let first = true;
    for (;;) {
      const seq = next++;
      if (seq >= config.requests) return;
      if (!first && config.intervalMs > 0) await sleep(config.intervalMs);
      first = false;
      const t0 = performance.now();
      try {
        const resp = await fetch(config.url, {
          method: config.method,
          headers: config.headers,
          body: config.body,
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        await resp.arrayBuffer(); // drain body so the socket can be reused
        const latencyMs = performance.now() - t0;
        if (resp.status >= 200 && resp.status < 300) {
          outcomes[seq] = { seq, ok: true, statusCode: resp.status, latencyMs, failureKind: null, error: null };
        } else {
          outcomes[seq] = {
            seq, ok: false, statusCode: resp.status, latencyMs,
            failureKind: 'http_status',
            error: 'non-2xx status ' + resp.status,
          };
        }
      } catch (err) {
        const { kind, message } = classifyError(err);
        outcomes[seq] = {
          seq, ok: false, statusCode: null, latencyMs: performance.now() - t0,
          failureKind: kind, error: message,
        };
        log('request.failure', { seq, kind, reason: message });
      }
    }
  }

  const workerCount = Math.max(1, Math.min(config.concurrency, config.requests));
  log('run.workers', { workers: workerCount });
  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));

  const durationMs = Date.now() - startMs;

  // Every slot must be filled; a hole means the kernel dropped a result.
  const missing = outcomes.findIndex((o) => o === undefined);
  if (missing !== -1) {
    throw computationFailure('result for request seq=' + missing + ' was lost');
  }

  const successLat: number[] = [];
  const failureLat: number[] = [];
  const statusCodes: Record<string, number> = {};
  const failuresByKind: Record<FailureKind, number> = { http_status: 0, timeout: 0, connection: 0 };
  for (const o of outcomes) {
    if (o.ok) successLat.push(o.latencyMs);
    else {
      failureLat.push(o.latencyMs);
      failuresByKind[o.failureKind as FailureKind]++;
    }
    if (o.statusCode !== null) {
      const k = String(o.statusCode);
      statusCodes[k] = (statusCodes[k] ?? 0) + 1;
    }
  }

  const succeeded = successLat.length;
  const failed = failureLat.length;
  const throughputRps = durationMs > 0 ? (outcomes.length / durationMs) * 1000 : 0;
  log('run.done', { total: outcomes.length, succeeded, failed, durationMs, throughputRps: +throughputRps.toFixed(2) });

  return {
    config,
    startedAt,
    durationMs,
    total: outcomes.length,
    succeeded,
    failed,
    failuresByKind,
    statusCodes,
    throughputRps,
    successLatency: summarize(successLat),
    failureLatency: summarize(failureLat),
    outcomes,
  };
}
