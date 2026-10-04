import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.ts";
import { EventStore } from "./state/store.ts";
import { IndexerService } from "./kernel/indexer.ts";
import { HttpApp } from "./diag/http.ts";
import { registerRoutes } from "./diag/routes.ts";

export interface RunningServer {
  close: () => Promise<void>;
  port: number;
  runId: string;
  store: EventStore;
}

export async function buildServer(options?: {
  dbPath?: string;
  port?: number;
  runId?: string;
}): Promise<RunningServer> {
  const base = loadConfig();
  const port = options?.port ?? base.port;
  const dbPath = resolve(options?.dbPath ?? base.dbPath);
  const runId = options?.runId ?? base.runId;

  mkdirSync(dirname(dbPath), { recursive: true });

  const store = EventStore.open(dbPath);
  const indexer = new IndexerService(store);
  const http = new HttpApp({ port, dbPath, runId });
  registerRoutes(http, indexer, store);

  const boundPort = await http.listen(port);
  return {
    close: async () => {
      await http.close();
      store.close();
    },
    port: boundPort,
    runId,
    store,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const config = loadConfig();
  const dbPath = resolve(config.dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = EventStore.open(dbPath);
  const indexer = new IndexerService(store);
  const http = new HttpApp({ ...config, dbPath });
  registerRoutes(http, indexer, store);
  const boundPort = await http.listen(config.port);
  console.log(JSON.stringify({ msg: "nft-indexer listening", port: boundPort, dbPath, runId: config.runId }));
}

