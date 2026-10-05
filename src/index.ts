import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

const config = loadConfig();
const server = await startServer(config);
console.log(`test-data-factory listening on http://${config.host}:${server.port} (adapter: ${server.adapter}, db: ${config.dbPath})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
