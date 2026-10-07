// Local demo: boots the service with a virtual clock and walks a mini
// lifecycle (register -> heartbeat -> expire -> reuse -> release -> table).
import { loadConfig } from "../src/config.ts";
import { buildServer } from "../src/server.ts";

const config = loadConfig({
  TUNNEL_HTTP_PORT: "0",
  TUNNEL_PORT_START: "20000",
  TUNNEL_PORT_END: "20004",
  TUNNEL_LEASE_TTL_MS: "5000",
  TUNNEL_DB_PATH: ":memory:",
  TUNNEL_CLOCK: "virtual",
  TUNNEL_VIRTUAL_START_MS: "1000000",
});
const { app } = buildServer(config);
await app.listen({ host: "127.0.0.1", port: 0 });
const addr = app.server.address();
const base = "http://127.0.0.1:" + (typeof addr === "object" && addr ? addr.port : 0);

async function call(method: string, path: string, body?: unknown): Promise<void> {
  const init: Record<string, unknown> = { method, headers: {} as Record<string, string> };
  if (body !== undefined) { init.body = JSON.stringify(body); (init.headers as Record<string, string>)["content-type"] = "application/json"; }
  const res = await fetch(base + path, init);
  console.log(method + " " + path + " -> " + res.status + " " + JSON.stringify(await res.json()));
}

const created = await fetch(base + "/leases", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ target: "ssh://demo-host:22" }),
}).then((r) => r.json()) as { lease: { id: string } };
console.log("registered:", JSON.stringify(created));

await call("POST", "/leases/" + created.lease.id + "/heartbeat");
await call("POST", "/diagnostics/clock/advance", { ms: 6000 });
await call("POST", "/leases", { target: "ssh://demo-host-2:22" });
await call("GET", "/forwarding-table");
await call("GET", "/leases?status=expired");
await call("GET", "/diagnostics");
await app.close();

