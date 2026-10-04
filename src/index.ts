import { loadConfig } from './config.js';
import { SystemClock } from './domain/clock.js';
import { RunStore } from './state/runStore.js';
import { buildApp } from './http/server.js';

const config = loadConfig();
const app = buildApp({
  config,
  clock: new SystemClock(),
  store: new RunStore(config.dbPath),
});

app.listen({ port: config.port, host: config.host }).then((addr) => {
  console.log(`cert-chain service listening at ${addr}`);
});

