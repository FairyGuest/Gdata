// Service entry point: wires config, store, builder fixture, engine and HTTP.

import { loadConfig } from "./config.ts";
import { SqliteBuildStore } from "./store/sqlite.ts";
import { FixtureBuilder } from "./adapters/builder.ts";
import { RingLogger } from "./adapters/logger.ts";
import { Engine } from "./core/engine.ts";
import { buildServer } from "./http/server.ts";

const config = loadConfig();
const store = new SqliteBuildStore(config.dbPath);
const builder = new FixtureBuilder(config.buildDelayMs);
const logger = new RingLogger(config.logFile);
const engine = new Engine({
  store,
  builder,
  config: { workspaceRoot: config.workspaceRoot, maxQueueSize: config.maxQueueSize },
  logger,
});

const app = buildServer({ engine, store, logger, config });

app.listen({ port: config.port, host: config.host }).then(() => {
  console.log("incremental-build-orchestrator listening on http://" + config.host + ":" + config.port);
  console.log("workspace root: " + config.workspaceRoot);
  console.log("sqlite db:      " + config.dbPath);
});
