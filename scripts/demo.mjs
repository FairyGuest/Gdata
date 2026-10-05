// Local demo: starts a controllable target server and the load-tester
// service in-process, runs a mixed load, prints the summary.
import { startTarget } from "../test/helpers.ts";
import { NodeHttpAdapter } from "../src/http-adapter.ts";
import { Store } from "../src/store.ts";
import { Runner } from "../src/runner.ts";
import { registerRoutes } from "../src/server.ts";

const target = await startTarget();
const store = new Store(":memory:");
const runner = new Runner(store);
const adapter = new NodeHttpAdapter();
registerRoutes({ adapter, store, runner });
const { port } = await adapter.listen(0);
const base = `http://127.0.0.1:${port}`;
console.log(`service: ${base}  target: ${target.url}`);

const start = await fetch(base + "/runs", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ targetUrl: target.url + "/flaky", concurrency: 4, totalRequests: 40, requestIntervalMs: 10, timeoutMs: 2000 }),
}).then((r) => r.json());
console.log("started:", start.runId);

let run;
do {
  await new Promise((r) => setTimeout(r, 200));
  run = await fetch(base + "/runs/" + start.runId).then((r) => r.json());
} while (run.status === "running");

console.log(JSON.stringify(run.summary, null, 2));
await adapter.close();
store.close();
await target.close();
