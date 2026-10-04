// Service entry point.
import { loadConfig } from './config.ts';
import { Store } from './state/store.ts';
import { ScanEngine } from './core/engine.ts';
import { buildServer } from './api/server.ts';

const config = loadConfig();
const store = new Store(config.dbPath);
const loaded = store.loadVulnDb(config.vulnDbPath);
const engine = new ScanEngine(store, config);
const app = buildServer(engine, store);

const url = await app.listen({ port: config.port, host: config.host });
console.log('[sbom-scanner] listening at ' + url);
console.log('[sbom-scanner] vulnerability database: ' + loaded + ' entries from ' + config.vulnDbPath);
console.log('[sbom-scanner] state database: ' + config.dbPath);
