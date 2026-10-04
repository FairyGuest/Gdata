import { loadConfig } from "./config.ts";
import { SystemClock, VirtualClock } from "./clock.ts";
import { TokenStore } from "./store.ts";
import { TokenService } from "./service.ts";
import { buildServer } from "./http.ts";

const config = loadConfig();
const clock =
  config.clock === "virtual" ? new VirtualClock(config.virtualStartMs) : new SystemClock();
const store = new TokenStore(config.dbPath);
const service = new TokenService(store, clock, config.secret, config.runId, (e) => {
  console.log(JSON.stringify({ level: "decision", ...e }));
});
const app = buildServer({
  service,
  virtualClock: clock instanceof VirtualClock ? clock : undefined,
});

app
  .listen({ port: config.port, host: config.host })
  .then((addr) => {
    console.log(
      JSON.stringify({
        level: "info",
        runId: config.runId,
        msg: "jwt-lifecycle-service listening",
        addr,
        clock: config.clock,
        db: config.dbPath,
      })
    );
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });