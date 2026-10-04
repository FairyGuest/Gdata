import { defaultConfig } from "./config.js";
import { buildApp } from "./server.js";

const { app } = buildApp(defaultConfig);
const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "127.0.0.1" }).then(() => {
  console.log("dynamic-nft-metadata listening on http://127.0.0.1:" + port);
});
