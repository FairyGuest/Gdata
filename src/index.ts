// Service entry point.
//   PORT (default 8080), HOST (default 127.0.0.1), DB_PATH (default ./loadtest.db)

import { NodeHttpAdapter } from "./http-adapter.ts";
import { Store } from "./store.ts";
import { Runner } from "./runner.ts";
import { registerRoutes } from "./server.ts";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "127.0.0.1";
const dbPath = process.env.DB_PATH ?? "./loadtest.db";

const store = new Store(dbPath);
const runner = new Runner(store, { logger: (line) => console.log(line) });
const adapter = new NodeHttpAdapter();
registerRoutes({ adapter, store, runner });

const { port: bound } = await adapter.listen(port, host);
console.log(`load-tester listening on http://${host}:${bound} (db=${dbPath})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void adapter.close().then(() => { store.close(); process.exit(0); });
  });
}
