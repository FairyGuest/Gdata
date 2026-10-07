/** Local demo: boots the service on an ephemeral port and walks the main flows. */
import { buildServer } from "../src/http/server.js";

const { app, engine } = buildServer({ host: "127.0.0.1", port: 0, dbPath: ":memory:" });
await app.listen({ host: "127.0.0.1", port: 0 });
const addr = app.server.address() as { port: number };
const base = `http://127.0.0.1:${addr.port}`;
console.log(`demo runId=${engine.runId} base=${base}`);

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  console.log(`> ${method} ${path}`, body ?? "", `\n< ${res.status}`, JSON.stringify(json));
  return json;
}

await call("POST", "/nodes", { id: "node-1", capacity: { cpu: 4, memoryMb: 4096 } });
await call("POST", "/nodes", { id: "node-2", capacity: { cpu: 8, memoryMb: 8192 } });
await call("POST", "/namespaces", { name: "team-a", quota: { cpu: 4, memoryMb: 4096 } });
await call("POST", "/workloads", { id: "job-1", namespace: "team-a", request: { cpu: 2, memoryMb: 2048 } });
await call("POST", "/workloads", { id: "job-2", namespace: "team-a", request: { cpu: 3, memoryMb: 3072 } }); // quota exceeded
await call("POST", "/workloads", { id: "job-3", namespace: "team-a", request: { cpu: 2, memoryMb: 2048 } }); // placed on node-2 (first-fit)
await call("DELETE", "/workloads/job-1");
await call("GET", "/diag/state");
await app.close();

