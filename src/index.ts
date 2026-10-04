import { loadConfig } from "./config";
import { buildServer } from "./http/server";
import { AuditStore } from "./state/store";

const config = loadConfig();

const store = new AuditStore(config.dbPath, { maxEvents: config.maxEvents });
const app = buildServer(store);

app
  .listen({ port: config.port, host: config.host })
  .then(() => app.log.info("audit-chain listening on " + config.port))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    app.close().then(() => {
      store.close();
      process.exit(0);
    });
  });
}
