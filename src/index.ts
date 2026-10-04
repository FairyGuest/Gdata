import { loadConfig } from "./config.ts";
import { SystemClock } from "./clock.ts";
import { AesGcmCipher } from "./crypto.ts";
import { SqliteStore } from "./store.ts";
import { VaultCore } from "./core.ts";
import { buildServer } from "./server.ts";

const config = loadConfig();
const clock = new SystemClock();
const store = new SqliteStore(config.dbPath);
const cipher = new AesGcmCipher(config.masterKeyHex);
const core = new VaultCore({ store, cipher, clock, gracePeriodMs: config.gracePeriodMs, runId: config.runId });
const app = buildServer({ core, store, clock, runId: config.runId });

app
  .listen({ port: config.port, host: config.host })
  .then((addr) => {
    console.log(`[vault] runId=${config.runId} listening at ${addr} db=${config.dbPath} graceMs=${config.gracePeriodMs}`);
  })
  .catch((err) => {
    console.error("[vault] failed to start:", err);
    process.exit(1);
  });

process.on("SIGINT", () => {
  store.close();
  process.exit(0);
});
