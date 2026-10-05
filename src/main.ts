import { loadConfig } from "./config.ts";
import { SnapshotEngine } from "./core/engine.ts";
import { SqliteSnapshotStore } from "./store/sqlite.ts";
import { createHttpServer } from "./http/server.ts";

const config = loadConfig();
const store = new SqliteSnapshotStore(config.store.file);
const engine = new SnapshotEngine(store, config.limits, (level, event, fields) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  (level === "error" ? process.stderr : process.stdout).write(line + "\n");
});
const server = createHttpServer(engine, { maxPayloadBytes: config.limits.maxPayloadBytes });

server.listen(config.server.port, config.server.host, () => {
  process.stdout.write(
    JSON.stringify({
      event: "listening",
      host: config.server.host,
      port: config.server.port,
      db: config.store.file,
    }) + "\n",
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
