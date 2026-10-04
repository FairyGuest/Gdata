/**
 * Local demo: boots the real HTTP server (system clock, file db) and walks
 * through write/read/rotate/grace-expiry against it. Run: npm run demo
 */
import { loadConfig } from "../src/config.ts";
import { SystemClock } from "../src/clock.ts";
import { AesGcmCipher } from "../src/crypto.ts";
import { SqliteStore } from "../src/store.ts";
import { VaultCore } from "../src/core.ts";
import { buildServer } from "../src/server.ts";

const GRACE_MS = 2_000;
const config = loadConfig(process.env, { gracePeriodMs: GRACE_MS, dbPath: "./data/demo-vault.db", port: 8791 });
const clock = new SystemClock();
const store = new SqliteStore(config.dbPath);
const core = new VaultCore({ store, cipher: new AesGcmCipher(config.masterKeyHex), clock, gracePeriodMs: GRACE_MS, runId: config.runId });
const app = buildServer({ core, store, clock, runId: config.runId });

const base = await app.listen({ port: config.port, host: config.host });
console.log(`[demo] runId=${config.runId} server at ${base} (grace ${GRACE_MS}ms)`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-actor": "demo" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  console.log(`[demo] ${method} ${path} -> ${res.status}`, JSON.stringify(json));
  return json;
}

await call("PUT", "/secrets/demo.api-key", { value: "key-v1" });
await call("PUT", "/secrets/demo.api-key", { value: "key-v2" });
await call("GET", "/secrets/demo.api-key?version=1");
await call("POST", "/secrets/demo.api-key/rotate", {});
console.log(`[demo] inside grace window: old version still readable`);
await call("GET", "/secrets/demo.api-key?version=2");
console.log(`[demo] waiting ${GRACE_MS}ms for grace to elapse...`);
await sleep(GRACE_MS + 50);
await call("GET", "/secrets/demo.api-key?version=2"); // expect 410 VERSION_EXPIRED
await call("GET", "/audit?name=demo.api-key");
await call("GET", "/healthz");

await app.close();
store.close();
console.log("[demo] done");
