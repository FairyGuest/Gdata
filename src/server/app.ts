import { loadConfig, type ServiceConfig } from "../config/config.ts";
import { Logger } from "../diagnostics/logger.ts";
import { SqliteSnapshotStore } from "../store/sqliteStore.ts";
import { SnapshotEngine } from "../core/engine.ts";
import { Router } from "./router.ts";
import { NodeHttpAdapter, type HttpAdapter } from "./httpAdapter.ts";

export interface RunningApp {
  adapter: HttpAdapter;
  config: ServiceConfig;
  close(): Promise<void>;
}

// Composition root: wires config -> store -> engine -> router -> adapter.
// Tries Fastify first (declared dependency); falls back to node:http when
// the package is unavailable (e.g. offline install was skipped).
export async function buildApp(overrides: Partial<ServiceConfig> = {}): Promise<RunningApp> {
  const config = loadConfig(overrides);
  const logger = new Logger(config.logFile);
  const store = new SqliteSnapshotStore(config.dbPath);
  const engine = new SnapshotEngine(store, logger, { maxSnapshots: config.maxSnapshots });
  const router = new Router(engine, logger);

  let adapter: HttpAdapter;
  try {
    const fastifyPkg = "fastify"; // indirect specifier: optional dependency, resolved at runtime
    const mod = await import(fastifyPkg);
    const { FastifyAdapter } = await import("./fastifyAdapter.ts");
    adapter = new FastifyAdapter(router, config.maxPayloadBytes, mod.default);
  } catch {
    adapter = new NodeHttpAdapter(router, config.maxPayloadBytes);
  }

  return {
    adapter,
    config,
    async close() {
      await adapter.close();
      store.close();
    },
  };
}
