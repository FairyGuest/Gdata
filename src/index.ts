import { loadConfig } from "./config.ts";
import { SystemClock } from "./clock.ts";
import { buildApp } from "./server.ts";

const config = loadConfig();
const { app, runId } = buildApp({ config, clock: new SystemClock() });

app
  .listen({ host: config.host, port: config.port })
  .then((addr) => {
    console.log(JSON.stringify({ event: "listening", runId, addr, config }));
  })
  .catch((err) => {
    console.error(JSON.stringify({ event: "listen_failed", error: String(err) }));
    process.exit(1);
  });
