import Fastify, { type FastifyInstance } from "fastify";
import { loadConfig, type AppConfig } from "./config/index.js";
import { createIdFactory } from "./contract/ids.js";
import { isAppError } from "./contract/errors.js";
import { createRunIdFactory } from "./diag/run-id.js";
import { JsonlDiagLogger } from "./diag/logger.js";
import { mapFastifyError, registerRoutes } from "./diag/http-routes.js";
import { Matcher } from "./kernel/matcher.js";
import { LedgerQueries } from "./kernel/queries.js";
import { bootLedger } from "./state/bootstrap.js";
import type { SqliteEngine } from "./state/sqlite-engine.js";

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly config: AppConfig;
  readonly matcher: Matcher;
  readonly engine: SqliteEngine;
  readonly logger: JsonlDiagLogger;
  readonly close: () => Promise<void>;
}

export async function buildApp(overrides: Partial<AppConfig> = {}): Promise<BuiltApp> {
  const config = loadConfig(process.env, overrides);
  const { engine, seed } = await bootLedger(config);
  const logger = new JsonlDiagLogger(config.logFilePath);
  const matcher = new Matcher({
    engine,
    logger,
    newRunId: createRunIdFactory(),
    newBidId: createIdFactory("bid"),
  });
  const queries = new LedgerQueries(engine);
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

  registerRoutes(app, { matcher, queries, logger, newRunId: createRunIdFactory(), seed });

  app.setErrorHandler((error, _request, reply) => {
    const mapped = mapFastifyError(error);
    const resolved = mapped ?? (isAppError(error) ? error : null);
    if (resolved) {
      return reply.status(resolved.statusCode).send({
        error: {
          category: resolved.category,
          reason: resolved.reason,
          message: resolved.message,
          ...(resolved.details ? { details: resolved.details } : {}),
        },
      });
    }
    return reply.status(500).send({
      error: { category: "compute", reason: "unexpected_error", message: (error as Error).message },
    });
  });

  return {
    app,
    matcher,
    engine,
    logger,
    config,
    close: async () => {
      await app.close();
      engine.close();
    },
  };
}
