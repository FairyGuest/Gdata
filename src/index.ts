import { loadConfig } from "./config.ts";
import { SystemClock } from "./clock.ts";
import { QuotaKernel } from "./kernel.ts";
import { RunLogger } from "./logger.ts";
import { buildServer } from "./server.ts";
import { Store } from "./store.ts";

const config = loadConfig();
const runId = `run-${Date.now()}`;
const store = new Store(config.dbPath);
const logger = new RunLogger(runId, config.logDir);
const kernel = new QuotaKernel(store, new SystemClock(), logger);
const app = buildServer(kernel, config);

app
  .listen({ host: config.host, port: config.port })
  .then((addr) => {
    console.log(`api-key-quota-service listening at ${addr} (runId=${runId}, db=${config.dbPath})`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

