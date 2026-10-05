import Fastify, { type FastifyInstance } from "fastify";
import { discoverTests } from "../contract/parser.ts";
import { RunnerError, inputError, resourceExhausted, stateConflict, notFound } from "../contract/errors.ts";
import { runSuite } from "../kernel/runner.ts";
import { adaptAll } from "../status/adapter.ts";
import type { ResultStore } from "../store/db.ts";
import type { RunnerConfig } from "../config.ts";
import type { RunSummary } from "../contract/types.ts";

interface RunBody {
  dir?: string;
  pattern?: string;
  parallel?: number;
  timeoutMs?: number;
}

/** Build the diagnostics/execution HTTP API. */
export function buildApp(cfg: RunnerConfig, store: ResultStore): FastifyInstance {
  const app = Fastify({ logger: false });
  const activeDirs = new Set<string>();
  let activeRuns = 0;

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RunnerError) {
      void reply.status(err.httpStatus).send({ error: { code: err.code, message: (err as Error).message } });
      return;
    }
    const status = (err as unknown as { statusCode?: number }).statusCode ?? 500;
    const code = status === 400 ? "INPUT_ERROR" : "EXECUTION_ERROR";
    void reply.status(status).send({ error: { code, message: (err as Error).message } });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/diagnostics", async () => ({
    config: cfg,
    activeRuns,
    activeDirs: [...activeDirs],
  }));

  app.post("/runs", async (req, reply) => {
    const body = (req.body ?? {}) as RunBody;
    const dir = body.dir;
    if (!dir || typeof dir !== "string") throw inputError("'dir' is required and must be a string");
    const pattern = body.pattern ?? cfg.pattern;
    const parallel = body.parallel ?? cfg.parallel;
    const timeoutMs = body.timeoutMs ?? cfg.timeoutMs;
    if (!Number.isInteger(parallel) || parallel < 1) throw inputError("'parallel' must be a positive integer");
    if (parallel > cfg.maxParallel) {
      throw resourceExhausted("parallel=" + parallel + " exceeds maxParallel=" + cfg.maxParallel);
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw inputError("'timeoutMs' must be a positive integer");
    if (activeRuns >= cfg.maxConcurrentRuns) {
      throw resourceExhausted("too many concurrent runs (max " + cfg.maxConcurrentRuns + ")");
    }
    if (activeDirs.has(dir)) {
      throw stateConflict("a run is already in progress for dir: " + dir);
    }

    activeRuns++;
    activeDirs.add(dir);
    try {
      const files = await discoverTests(dir, pattern);
      const events: string[] = [];
      const outcome = await runSuite({
        files,
        parallel,
        timeoutMs,
        onEvent: (ev) => {
          const line = ev.ts + " [" + ev.runId.slice(0, 8) + "] " + ev.event +
            (ev.caseId ? " " + ev.caseId : "") + " - " + ev.reason;
          events.push(line);
          app.log.info(line);
        },
      });
      const results = adaptAll(files, outcome.outcomes);
      const summary: RunSummary = {
        runId: outcome.runId,
        dir,
        pattern,
        startedAt: outcome.startedAt,
        finishedAt: outcome.finishedAt,
        durationMs: outcome.durationMs,
        total: results.length,
        passed: results.filter((r) => r.status === "passed").length,
        failed: results.filter((r) => r.status === "failed").length,
        timeout: results.filter((r) => r.status === "timeout").length,
        results,
      };
      store.saveRun(summary);
      void reply.status(201);
      return summary;
    } finally {
      activeRuns--;
      activeDirs.delete(dir);
    }
  });

  app.get("/runs/:runId", async (req) => {
    const { runId } = req.params as { runId: string };
    const run = store.getRun(runId);
    if (!run) throw notFound("run not found: " + runId);
    return run;
  });

  app.get("/runs", async (req) => {
    const q = req.query as { file?: string; from?: string; to?: string };
    for (const key of ["from", "to"] as const) {
      const v = q[key];
      if (v !== undefined && Number.isNaN(Date.parse(v))) {
        throw inputError("'" + key + "' must be an ISO timestamp, got: " + v);
      }
    }
    return { runs: store.queryRuns({ file: q.file, from: q.from, to: q.to }) };
  });

  return app;
}
