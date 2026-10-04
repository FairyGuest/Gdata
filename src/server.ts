import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const app = buildApp(process.env.SQLITE_FILE ?? ':memory:').app;

app.listen({ port, host: '127.0.0.1' }).then(() => {
  console.log(`NFT ticketing listening on http://127.0.0.1:${port}`);
});
