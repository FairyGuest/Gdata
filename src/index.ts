import { buildServer, listen } from './api/server.ts';
import { loadConfig } from './config.ts';
import { Store } from './state/store.ts';

const config = loadConfig();
const store = new Store(config.dbPath);
const server = buildServer(store, config);
const port = await listen(server, config.port);
console.log('lint-engine listening on http://127.0.0.1:' + port + ' (db: ' + config.dbPath + ')');

