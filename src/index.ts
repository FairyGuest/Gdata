// Service entry point.

import { mkdirSync } from "node:fs";
import { RunStore } from "./state/store.ts";
import { DriftService, consoleLogger } from "./core/service.ts";
import { buildRouter } from "./server/app.ts";
import { createNodeHttpAdapter } from "./server/http.ts";

const port = Number(process.env["PORT"] ?? 8080);
const host = process.env["HOST"] ?? "127.0.0.1";
const dbPath = process.env["DB_PATH"] ?? "data/env-drift.db";

if (dbPath !== ":memory:") {
  mkdirSync(dbPath.slice(0, dbPath.lastIndexOf("/")) || ".", { recursive: true });
}

const store = new RunStore(dbPath);
const service = new DriftService(store, consoleLogger);
const adapter = createNodeHttpAdapter(buildRouter(service));

const { port: bound } = await adapter.listen(port, host);
console.log(JSON.stringify({ event: "server.listening", host, port: bound, db: dbPath }));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await adapter.close();
    store.close();
    process.exit(0);
  });
}
