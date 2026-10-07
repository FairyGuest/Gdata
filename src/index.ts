// Service entry point.
import { loadConfig } from './config.ts';
import { buildServer } from './server.ts';

const config = loadConfig();
const { app } = buildServer(config);

app.listen({ host: config.host, port: config.port }).then(() => {
  console.log('namespace-quota service listening on http://' + config.host + ':' + config.port);
  console.log('db: ' + config.dbPath);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});

