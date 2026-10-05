import { loadConfig } from './config.ts';
import { DatasetStore } from './state/store.ts';
import { createHandler } from './http/core.ts';
import { startNodeServer } from './http/node-server.ts';

const config = loadConfig();
const store = new DatasetStore(config.dbPath);
const handle = createHandler(store, config);

let backend = 'node:http (built-in fallback)';
try {
  const { startFastifyServer } = await import('./http/fastify-server.ts');
  await startFastifyServer(handle, config.port);
  backend = 'fastify';
} catch (e) {
  await startNodeServer(handle, config.port);
  const msg = e instanceof Error ? e.message : String(e);
  if (!/Cannot find (module|package)/.test(msg)) {
    console.error('[factory] fastify unavailable (' + msg + '), using fallback');
  }
}

console.log('[factory] listening on http://localhost:' + config.port + ' (backend: ' + backend + ', db: ' + config.dbPath + ')');
