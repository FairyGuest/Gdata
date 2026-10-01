import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { openDatabase, migrate } from "./state/db.js";
import { seedDatabase } from "./state/fixtures.js";
import { TokenRepository } from "./state/repository.js";
import { Diagnostics } from "./diag/queries.js";
import { buildServer, AppContext } from "./server.js";

export function createContext(dbFile: string = ":memory:", runId: string = randomUUID()): { ctx: AppContext; app: ReturnType<typeof buildServer> } {
  const config = { ...loadConfig(), dbFile };
  const db = openDatabase(config.dbFile);
  migrate(db);
  seedDatabase(db);
  const repo = new TokenRepository(db);
  const diag = new Diagnostics(db);
  const ctx: AppContext = { runId, db, repo, diag, config };
  return { ctx, app: buildServer(ctx) };
}

if (import.meta.url === new URL(`file://${process.argv[1]?.replace(/\\/g, "/")}`).href || process.argv[1]?.endsWith("main.ts")) {
  const config = loadConfig();
  const runId = process.env.NFT_RUN_ID ?? randomUUID();
  const { app } = createContext(config.dbFile, runId);
  const port = Number(process.env.PORT ?? "3000");
  app
    .listen({ port, host: "127.0.0.1" })
    .then(() => {
      app.log.info(`dynamic-nft listening on http://127.0.0.1:${port} run=${runId}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

