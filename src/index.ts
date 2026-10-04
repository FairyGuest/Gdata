/** Service entry point: loads config, builds the server, listens. */
import { loadConfig } from './config.ts';
import { buildServer } from './server.ts';

const config = loadConfig();
const { app } = buildServer({ config });

app
  .listen({ port: config.port, host: config.host })
  .then((address) => {
    console.log('jwt-lifecycle-service listening at ' + address);
  })
  .catch((err) => {
    console.error('failed to start:', err);
    process.exit(1);
  });
