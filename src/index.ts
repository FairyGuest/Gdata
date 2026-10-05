// Service entry point.
import { buildApp } from './server.ts';
import { RunStore } from './store.ts';

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? 'loadtest.db';
const app = buildApp({ store: new RunStore(dbPath) });
const address = await app.listen(port, '127.0.0.1');
console.log('load-tester-B listening on ' + address + ' (db: ' + dbPath + ')');
