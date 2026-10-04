// 服务入口：加载配置、初始化状态层（含漏洞库种子）、注册路由、启动监听。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../config.ts';
import { Store } from '../state/store.ts';
import { createApp } from './fastify-lite.ts';
import { registerRoutes } from './routes.ts';

const here = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const store = new Store(config.dbPath);
const seeded = store.seedVulnerabilities(
  JSON.parse(readFileSync(join(here, '..', '..', 'fixtures', 'vulnerabilities.json'), 'utf8')));
if (seeded > 0) console.log(`[main] seeded ${seeded} vulnerabilities into ${config.dbPath}`);

const app = createApp();
registerRoutes(app, store, config);
await app.listen(config.port, config.host);
console.log(`[main] sbom-scanner listening on http://${config.host}:${config.port}`);
