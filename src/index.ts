import { loadConfig } from "./config.ts";
import { Store } from "./state/store.ts";
import { BindingService } from "./service/service.ts";
import { buildServer } from "./http/server.ts";

const config = loadConfig();
const store = new Store(config.dbPath);
const service = new BindingService(store, config.fingerprintLength);
const app = buildServer(service);

app
  .listen({ port: config.port, host: config.host })
  .then((addr) => {
    console.log(`env-secrets-binding listening on ${addr} (db: ${config.dbPath})`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => {
      store.close();
      process.exit(0);
    });
  });
}
