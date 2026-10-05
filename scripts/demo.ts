// Local demo: boots the service on an ephemeral port with an in-memory
// database and walks through the main scenarios, printing each exchange.
import { buildApp } from "../src/server/app.ts";

const app = await buildApp({ port: 0, dbPath: ":memory:", logFile: undefined });
await app.adapter.listen(0, "127.0.0.1");
const base = "http://127.0.0.1:" + app.adapter.port();
console.log("demo server (" + app.adapter.kind + ") at " + base + "\n");

async function compare(label: string, payload: unknown) {
  const res = await fetch(base + "/snapshots/compare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  console.log("== " + label);
  console.log("request : " + JSON.stringify(payload));
  console.log("response: HTTP " + res.status + " " + JSON.stringify(body) + "\n");
}

const v1 = { user: { name: "ann", address: { city: "Beijing", zip: "100000" } }, tags: ["a", "b"], meta: { ts: 1700000000 } };
const v2 = { user: { name: "ann", address: { city: "Shanghai", zip: "100000" } }, tags: ["a", "b", "c"], meta: { ts: 1700009999 } };

await compare("1. first call auto-creates snapshot", { name: "demo", data: v1 });
await compare("2. identical call passes", { name: "demo", data: v1 });
await compare("3. nested + array diffs reported", { name: "demo", data: v2 });
await compare("4. ignored paths suppress noise", { name: "demo", data: v2, ignorePaths: ["meta.ts", "user.address.city", "tags[2]"] });
await compare("5. force update snapshot", { name: "demo", data: v2, update: true });
await compare("6. updated snapshot now passes", { name: "demo", data: v2 });

await app.close();
console.log("demo done");
