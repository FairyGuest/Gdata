// 服务入口。

import { loadConfig } from "./config.ts";
import { buildApp } from "./app.ts";

const config = loadConfig();
const { app } = buildApp(config);

app.listen(config.port, config.host).then(() => {
  console.log(`test-reporter listening on http://${config.host}:${config.port}`);
});

