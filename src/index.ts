// Service entry point.

import { loadConfig } from './config.ts';
import { MutationKernel } from './kernel.ts';
import { MutationStore } from './store.ts';
import { createServer } from './http.ts';

const config = loadConfig();
const kernel = new MutationKernel(config);
const store = new MutationStore(config.dbPath);
const server = createServer(kernel, store);

server.listen(config.port, config.host, () => {
  console.log('mutation-testing service listening on http://' + config.host + ':' + config.port);
  console.log('sqlite db: ' + config.dbPath);
});

const shutdown = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
