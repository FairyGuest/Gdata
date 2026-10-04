import { loadConfig } from './config.ts';
import { Journal } from './diag/journal.ts';
import { bootstrapLedger } from './fixtures/seed.ts';
import { buildApp } from './http/app.ts';
import { MarketEngine } from './kernel/engine.ts';
import { Ledger } from './state/ledger.ts';

const config = loadConfig();
const ledger = new Ledger(config.dbPath);
const { runId } = bootstrapLedger(ledger, config.seed);
const journal = new Journal(ledger, runId);
const engine = new MarketEngine(ledger, journal);
const app = buildApp({ ledger, engine, journal, runId });

app
  .listen({ port: config.port, host: config.host })
  .then((address) => {
    console.log('nft-marketplace listening at ' + address + ' (runId=' + runId + ', seed=' + String(config.seed) + ')');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
