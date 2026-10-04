import type { AppConfig } from "../config/index.js";
import { buildFixtures } from "./fixtures.js";
import { ledgerRepo } from "./ledger-repo.js";
import { SqliteEngine } from "./sqlite-engine.js";

export interface Ledger {
  readonly engine: SqliteEngine;
  readonly seed: number;
}

export async function bootLedger(
  config: Pick<AppConfig, "dbPath" | "sqliteBusyTimeoutMs" | "lockTimeoutMs" | "seed">,
): Promise<Ledger> {
  const engine = new SqliteEngine({
    dbPath: config.dbPath,
    sqliteBusyTimeoutMs: config.sqliteBusyTimeoutMs,
    lockTimeoutMs: config.lockTimeoutMs,
    maxConnections: config.dbPath === ":memory:" ? 1 : 8,
  });
  engine.boot();
  const fixtures = buildFixtures(config.seed);
  await engine.writeTx((db) => {
    if (!ledgerRepo.isSeeded(db)) {
      ledgerRepo.seed(db, fixtures);
    }
  });
  return { engine, seed: config.seed };
}
