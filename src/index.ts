import { loadConfig } from "./config.js";
import { buildServer } from "./http/server.js";

const config = loadConfig();
const { app, engine } = buildServer(config);

app.listen({ host: config.host, port: config.port }).then(() => {
  console.log(`namespace-quota-service listening on http://${config.host}:${config.port} runId=${engine.runId} db=${config.dbPath}`);
});
