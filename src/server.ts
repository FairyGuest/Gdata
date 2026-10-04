import Fastify from "fastify";
import { openDb, seedFixtures } from "./state/db.js";
import { Engine, assertConserved } from "./kernel/engine.js";
import { KernelError, STATUS_BY_KIND } from "./kernel/errors.js";
import { parseBorrow, parseRepay, parseLiquidate } from "./contract/parse.js";
import { buildDiagRoutes } from "./diag/queries.js";

export function buildApp(dbPath = ":memory:") {
  const db = openDb(dbPath);
  seedFixtures(db);
  const engine = new Engine(db);
  const diag = buildDiagRoutes(engine);
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof KernelError) {
      return reply.status(STATUS_BY_KIND[err.kind]).send({ error: err.kind, reason: err.reason });
    }
    // Unknown failure: never report success, classify as compute failure.
    return reply.status(500).send({ error: "compute", reason: "compute_failure" });
  });

  app.post("/borrow", (req) => engine.borrow(parseBorrow(req.body)));
  app.post("/repay", (req) => engine.repay(parseRepay(req.body)));
  app.post("/liquidate", (req) => engine.liquidate(parseLiquidate(req.body)));

  app.get("/diag/loan/:id", (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      throw new KernelError("input", "invalid_field", "loan id must be an integer");
    }
    return diag.loan(id);
  });
  app.get("/diag/state", () => ({ ...diag.state(), conserved: assertConserved(db) }));

  return { app, engine, db };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "");
if (isMain) {
  const { app } = buildApp(process.env.DB_PATH ?? ":memory:");
  app.listen({ port: Number(process.env.PORT ?? 4399), host: "127.0.0.1" }).then((addr) => {
    console.log("nft-lending listening at " + addr);
  });
}
