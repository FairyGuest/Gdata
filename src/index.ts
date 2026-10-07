// Service entry point: real clock, SQLite file, HTTP listener.
//   npm start            (uses config/default.json, env vars override)

import { loadConfig } from "./config.ts";
import { SystemClock } from "./clock.ts";
import { SqliteLeaseStore } from "./sqliteStore.ts";
import { LeaseKernel } from "./kernel.ts";
import { buildServer } from "./server.ts";

const cfg = loadConfig();
const store = new SqliteLeaseStore(cfg.dbPath);
const kernel = new LeaseKernel({ clock: new SystemClock(), store, config: cfg });
const app = buildServer(kernel);

const url = await app.listen({ port: cfg.httpPort, host: cfg.httpHost });
console.log("tunnel-lease-service listening at " + url);
console.log("port range " + cfg.portMin + "-" + cfg.portMax + ", leaseTtlMs=" + cfg.leaseTtlMs + ", db=" + cfg.dbPath);

