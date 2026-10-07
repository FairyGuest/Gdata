import { buildServer } from './server.ts';

const port = Number(process.env.PORT ?? 3100);
const dbPath = process.env.DB_PATH ?? './data/orchestrator.db';

const { app } = buildServer({ dbPath, logger: true });

app.listen({ port, host: '127.0.0.1' }).then(() => {
  console.log(`orchestrator listening on http://127.0.0.1:${port}, db=${dbPath}`);
});
