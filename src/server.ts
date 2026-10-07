// Service entry point. Wires config -> clock -> store -> kernel -> HTTP.

import { defaultConfig } from './config.ts';
import { VirtualClock } from './kernel/clock.ts';
import { InstanceStore } from './store/sqlite.ts';
import { Provisioner } from './kernel/provisioner.ts';
import { buildServer } from './adapters/http.ts';

const config = defaultConfig;
const clock = new VirtualClock();
const store = new InstanceStore(config.dbPath);
const provisioner = new Provisioner(clock, store, config);
const server = buildServer(provisioner, clock);

server.listen(config.port, () => {
  console.log('devcontainer-registry listening on http://localhost:' + config.port);
  console.log('db: ' + config.dbPath + ' | features: ' + config.featureWhitelist.join(','));
});

process.on('SIGINT', () => { store.close(); server.close(); process.exit(0); });
