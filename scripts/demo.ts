// Local demo: boots the service in-process on an ephemeral port and walks
// through the main flows, printing each request and response.
import type { AddressInfo } from "node:net";
import { SnapshotEngine } from "../src/core/engine.ts";
import { SqliteSnapshotStore } from "../src/store/sqlite.ts";
import { createHttpServer } from "../src/http/server.ts";

const store = new SqliteSnapshotStore(":memory:");
const engine = new SnapshotEngine(store, { maxDiffEntries: 100, maxSerializedBytes: 100_000 },
  (level, event, fields) => console.log("[log]", level, event, JSON.stringify(fields)));
const server = createHttpServer(engine, { maxPayloadBytes: 100_000 });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;

async function show(title: string, method: string, path: string, body?: unknown) {
  console.log("\n--- " + title + " ---");
  console.log(method + " " + path, body ? JSON.stringify(body) : "");
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  console.log(res.status, JSON.stringify(await res.json(), null, 2));
}

await show("first call creates the snapshot", "POST", "/snapshots/compare",
  { key: "demo.user", data: { user: { address: { city: "beijing" } }, ts: 1 } });
await show("nested change produces field-level diff", "POST", "/snapshots/compare",
  { key: "demo.user", data: { user: { address: { city: "shanghai" } }, ts: 1 } });
await show("ignored timestamp passes", "POST", "/snapshots/compare",
  { key: "demo.user", data: { user: { address: { city: "beijing" } }, ts: 999 }, ignorePaths: ["ts"] });
await show("force update rewrites baseline", "POST", "/snapshots/update",
  { key: "demo.user", data: { user: { address: { city: "shanghai" } }, ts: 1 } });
await show("compare after update passes", "POST", "/snapshots/compare",
  { key: "demo.user", data: { user: { address: { city: "shanghai" } }, ts: 1 } });
await show("input error category", "POST", "/snapshots/compare", { key: "bad key!" });
await show("run history for replay", "GET", "/runs?key=demo.user");

server.close();
store.close();
