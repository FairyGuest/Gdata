import { loadConfig } from "./config.js";
import { buildApp } from "./server.js";

const config = loadConfig();
const { app } = buildApp(config);
const port = Number(config.port);

app
  .listen({ port, host: "127.0.0.1" })
  .then((address) => {
    console.log("nft-collection-bids listening at " + address + " runId=" + config.runId);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
