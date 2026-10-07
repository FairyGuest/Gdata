// Service entry point.
import { buildServer } from './diag/server.ts';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const dbPath = process.env.ENV_DRIFT_DB ?? 'data/env-drift.db';

const app = buildServer({ dbPath, logger: true });

app.listen({ port, host }).then((address) => {
  console.log(`env-drift service listening at ${address} (db: ${dbPath})`);
});
