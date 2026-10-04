
import { loadConfig, CLIENT_FIXTURES } from "./config.ts";
import { SystemClock } from "./clock.ts";
import { SqliteStore } from "./store.ts";
import { buildServer } from "./server.ts";

const config = loadConfig();
const store = new SqliteStore(config.dbPath);
const app = buildServer({ config, clock: new SystemClock(), store, clients: CLIENT_FIXTURES, logger: true });

app
  .listen({ port: config.port, host: config.host })
  .then((addr) => {
    console.log("oauth2-code-service listening at " + addr);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
