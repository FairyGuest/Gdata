// HTTP API surface. Wires routes onto an HttpAdapter. Error semantics:
// every failure is { error: { code, message, details? } } with a status code
// derived from the error taxonomy in errors.ts; nothing unknown is reported
// as success.

import { AppError } from "./errors.ts";
import { parseRunConfig } from "./config.ts";
import type { HttpAdapter } from "./http-adapter.ts";
import type { Runner } from "./runner.ts";
import type { Store } from "./store.ts";

export interface ServerDeps {
  adapter: HttpAdapter;
  store: Store;
  runner: Runner;
  startedAt?: Date;
}

function parseIso(v: string | undefined, name: string): string | undefined {
  if (v === undefined) return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new AppError("INPUT_ERROR", `query param ${name} is not a valid ISO timestamp`, { received: v });
  return new Date(t).toISOString();
}

export function registerRoutes(deps: ServerDeps): void {
  const { adapter, store, runner } = deps;
  const bootedAt = deps.startedAt ?? new Date();

  adapter.route("GET", "/health", async (_req, reply) => {
    reply.status(200).send({ status: "ok", uptimeMs: Date.now() - bootedAt.getTime() });
  });

  adapter.route("GET", "/diagnostics", async (_req, reply) => {
    reply.status(200).send({
      status: "ok",
      uptimeMs: Date.now() - bootedAt.getTime(),
      activeRuns: runner.activeCount,
      recentErrors: runner.recentErrors,
    });
  });

  // Start a load run. 202 Accepted with { runId }.
  adapter.route("POST", "/runs", async (req, reply) => {
    const config = parseRunConfig(req.body);
    const runId = runner.startRun(config);
    reply.status(202).send({ runId, status: "running" });
  });

  // List runs, optionally filtered by targetUrl / time range.
  adapter.route("GET", "/runs", async (req, reply) => {
    const from = parseIso(req.query.from, "from");
    const to = parseIso(req.query.to, "to");
    if (from && to && from > to) {
      throw new AppError("INPUT_ERROR", "query param from must be <= to", { from, to });
    }
    const runs = store.listRuns({ targetUrl: req.query.targetUrl, from, to });
    reply.status(200).send({ count: runs.length, runs });
  });

  adapter.route("GET", "/runs/:runId", async (req, reply) => {
    const run = store.getRun(req.params.runId);
    if (!run) throw new AppError("NOT_FOUND", `run not found: ${req.params.runId}`);
    reply.status(200).send(run);
  });

  // Raw per-request results of a finished (or running) run.
  adapter.route("GET", "/runs/:runId/results", async (req, reply) => {
    const run = store.getRun(req.params.runId);
    if (!run) throw new AppError("NOT_FOUND", `run not found: ${req.params.runId}`);
    reply.status(200).send({ runId: run.runId, results: store.getResults(run.runId) });
  });

  // Compare two completed runs side by side.
  adapter.route("GET", "/runs/:runId/compare/:otherId", async (req, reply) => {
    const a = store.getRun(req.params.runId);
    const b = store.getRun(req.params.otherId);
    if (!a) throw new AppError("NOT_FOUND", `run not found: ${req.params.runId}`);
    if (!b) throw new AppError("NOT_FOUND", `run not found: ${req.params.otherId}`);
    if (a.status !== "completed" || b.status !== "completed") {
      throw new AppError("STATE_CONFLICT", "both runs must be completed before comparison",
        { runA: a.status, runB: b.status });
    }
    reply.status(200).send({
      runA: a.summary,
      runB: b.summary,
      delta: {
        throughputRps: (a.summary!.throughputRps) - (b.summary!.throughputRps),
        avgSuccessMs: a.summary!.successStats && b.summary!.successStats
          ? a.summary!.successStats.avgMs - b.summary!.successStats.avgMs : null,
        p99SuccessMs: a.summary!.successStats && b.summary!.successStats
          ? a.summary!.successStats.p99Ms - b.summary!.successStats.p99Ms : null,
      },
    });
  });
}
