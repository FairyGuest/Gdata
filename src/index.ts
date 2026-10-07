// Runnable service entrypoint.
import { loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";

const config = loadConfig();
const { app } = buildServer(config);

app.listen({ host: config.httpHost, port: config.httpPort }).then((addr) => {
  console.log(JSON.stringify({ runId: config.runId, event: "server.listening", addr, config }));
});
