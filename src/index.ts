import fs from 'node:fs';
import { parseConfig } from './contracts/parse';
import { buildServer } from './server';

async function main(): Promise<void> {
  const configPath = process.env.CHAOS_CONFIG ?? 'config/default.json';
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const config = parseConfig(raw);
  const { app } = buildServer(config);
  await app.listen({ port: config.port, host: config.host });
  console.log('chaos-injector listening on http://' + config.host + ':' + config.port +
    ' -> target ' + config.targetUrl);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});