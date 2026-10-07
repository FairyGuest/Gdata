import { loadConfig } from './config.ts';
import { SystemClock } from './clock.ts';
import { openDb } from './state/db.ts';
import { Store } from './state/store.ts';
import { TemplateRegistry } from './core/registry.ts';
import { Provisioner } from './core/provisioner.ts';
import { buildApp } from './http/server.ts';

const cfg = loadConfig();
const clock = new SystemClock();
const db = openDb(cfg.dbPath);
const store = new Store(db);
const registry = new TemplateRegistry(store, clock, cfg);
const provisioner = new Provisioner(store, clock, cfg);
clock.start(1000, () => provisioner.tick());

const app = buildApp({ registry, provisioner });
const url = await app.listen({ port: cfg.port });
console.log('devcontainer-registry listening at ' + url);
console.log('config: ' + JSON.stringify({ ...cfg, dbPath: cfg.dbPath }));
