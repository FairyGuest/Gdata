// Service entry point: wires config -> contract -> store -> kernel -> HTTP.
// Prefers Fastify when installed; falls back to the zero-dependency adapter.

import { loadConfig, loadTemplate } from './config.ts';
import { EnvironmentStore } from './store/sqliteStore.ts';
import { LifecycleKernel } from './core/lifecycle.ts';
import { buildApp, type HttpApp } from './server.ts';
import { buildFastifyApp, fastifyAvailable } from './fastifyApp.ts';
import { RunLogger, ConsoleSink } from './logger.ts';

const config = loadConfig();
const template = loadTemplate(config);
const store = new EnvironmentStore(config.dbPath);
const logger = new RunLogger(new ConsoleSink());
const kernel = new LifecycleKernel(store, template, { now: () => Date.now() }, {
  quotaPerOwner: config.quotaPerOwner,
  deploySeconds: config.deploySeconds,
}, logger);

let app: HttpApp;
let stack: string;
if (await fastifyAvailable()) {
  app = await buildFastifyApp(kernel, store, null);
  stack = 'fastify';
} else {
  app = buildApp(kernel, store, null);
  stack = 'node:http (fastify not installed)';
}
await app.listen(config.port);
console.log(`preview-env-lifecycle [${stack}] listening on http://127.0.0.1:${app.port()} (template=${template.name}, db=${config.dbPath})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void app.close().then(() => process.exit(0)); });
}
