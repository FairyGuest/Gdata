import { loadConfig } from "./config.ts";
import { buildApp } from "./server.ts";

const config = loadConfig();
const { app } = buildApp(config);

app
  .listen({ port: config.port, host: config.host })
  .then((addr) => {
    console.log(`rbac-policy service listening at ${addr} (db: ${config.dbPath})`);
  })
  .catch((err) => {
    console.error("failed to start:", err);
    process.exit(1);
  });

