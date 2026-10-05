// Service entry point.
import { loadConfig } from './config.ts';
import { MutationStore } from './store/sqlite.ts';
import { MutationService } from './service.ts';
import { createHttpServer } from './server/http.ts';

const config = loadConfig();
const logger = (msg: string) => console.log(new Date().toISOString(), msg);

const store = new MutationStore(config.dbPath);
const service = new MutationService(store, config, logger);
const server = createHttpServer(service, logger);

server.listen(config.port, config.host, () => {
  logger('[boot] mutation-testing-service listening on http://' + config.host + ':' + config.port);
  logger('[boot] db=' + config.dbPath + ' testCommand="' + config.defaultTestCommand + '"');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    store.close();
    process.exit(0);
  });
}

