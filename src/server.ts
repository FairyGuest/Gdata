import { loadConfig } from './config.ts';
import { OrchestratorStore } from './store/db.ts';
import { buildApp } from './http/app.ts';

const config = loadConfig();
const store = new OrchestratorStore(config.dbPath);
const built = await buildApp(store, config);

await built.listen(config.port, config.host);
console.log('orchestrator listening on http://' + config.host + ':' + config.port + ' (driver: ' + built.driver + ', db: ' + config.dbPath + ')');

process.on('SIGINT', () => {
  void (async () => {
    await built.close();
    store.close();
    process.exit(0);
  })();
});
