import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SystemClock, VirtualClock } from './clock.js';
import { loadConfig } from './config.js';
import { Aes256GcmCipher } from './crypto.js';
import { VaultKernel } from './kernel.js';
import { buildServer } from './server.js';
import { VaultStore } from './store.js';

async function main(): Promise<void> {
  const configPath = process.env.VAULT_CONFIG ?? process.argv[2];
  const config = loadConfig(configPath);
  mkdirSync(dirname(config.dbPath), { recursive: true });

  const clock = config.useVirtualClock ? new VirtualClock(config.clockStartMs) : new SystemClock();
  const store = new VaultStore(config.dbPath);
  const cipher = new Aes256GcmCipher(Buffer.from(config.keyHex, 'hex'), config.keyId);
  const kernel = new VaultKernel(store, cipher, clock, config);
  const app = buildServer({ kernel, clock, startedAt: clock.now() });

  await app.listen({ host: config.host, port: config.port });
  console.log('secrets-vault listening on http://' + config.host + ':' + config.port);
  console.log('db=' + config.dbPath + ' keyId=' + cipher.keyId + ' virtualClock=' + config.useVirtualClock);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
