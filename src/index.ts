import { loadConfig } from "./config.ts";
import { ResultStore } from "./store/db.ts";
import { buildApp } from "./server/app.ts";

const cfg = loadConfig();
const store = new ResultStore(cfg.dbPath);
const app = buildApp(cfg, store);

app.listen({ host: cfg.host, port: cfg.port }).then(
  (addr) => console.log("test-runner listening on " + addr + " (db: " + cfg.dbPath + ")"),
  (err) => {
    console.error("failed to start:", err);
    process.exit(1);
  },
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => {
      store.close();
      process.exit(0);
    });
  });
}
