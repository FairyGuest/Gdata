// Service entry point.
import { loadConfig } from './config/config.ts';
import { LintStore } from './state/store.ts';
import { buildApp } from './api/server.ts';

const config = loadConfig(process.env.LINT_ENGINE_CONFIG ?? 'config/engine.config.json');
const store = new LintStore(config.dbPath);
const app = buildApp({ config, store });

const address = await app.listen({ port: config.port, host: config.host });
console.log(`[lint-engine] listening at ${address}`);
console.log(`[lint-engine] db=${config.dbPath} logs=${config.logDir}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.close().then(() => { store.close(); process.exit(0); });
  });
}
