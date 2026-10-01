import { loadConfig } from './config.js';
import { startServer } from './app.js';

const cfg = loadConfig();
const ctx = await startServer(cfg);
const address = ctx.app.server.address();
console.log(JSON.stringify({ ok: true, listening: address, dbPath: cfg.dbPath }));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await ctx.app.close();
    ctx.ledger.close();
    process.exit(0);
  });
}

