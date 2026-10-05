// 服务入口：npm run build && node dist/index.js [configPath] [port]
import { buildServer } from './server.js';
import { loadRouteConfigFile } from './config/loader.js';

const configPath = process.argv[2] ?? 'config/routes.demo.json';
const port = Number(process.argv[3] ?? process.env.PORT ?? 3000);

const rules = loadRouteConfigFile(configPath);
const { app } = buildServer({ rules, logger: true });

app.listen({ port, host: '0.0.0.0' }).then(() => {
  console.log(`mock-server started: http://localhost:${port}  rules=${rules.length}  config=${configPath}`);
});
