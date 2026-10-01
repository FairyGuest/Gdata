import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const built = await buildApp(config);
  await built.app.listen({ host: config.host, port: config.port });
  console.log('NFT fixed-price market listening on http://' + config.host + ':' + config.port);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      await built.close();
      process.exit(0);
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});