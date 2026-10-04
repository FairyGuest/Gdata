import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdFactory } from "../src/contract/ids.js";
import { InMemoryDiagLogger } from "../src/diag/logger.js";
import { createRunIdFactory } from "../src/diag/run-id.js";
import { Matcher } from "../src/kernel/matcher.js";
import { LedgerQueries } from "../src/kernel/queries.js";
import { buildFixtures } from "../src/state/fixtures.js";
import { ledgerRepo } from "../src/state/ledger-repo.js";
import { SqliteEngine } from "../src/state/sqlite-engine.js";

export interface TestHarness {
  readonly engine: SqliteEngine;
  readonly matcher: Matcher;
  readonly queries: LedgerQueries;
  readonly logger: InMemoryDiagLogger;
  readonly dbPath: string;
  readonly dir: string;
  dispose(): void;
}

export async function createHarness(options?: { seed?: number; lockTimeoutMs?: number; busyTimeoutMs?: number }): Promise<TestHarness> {
  const dir = mkdtempSync(join(tmpdir(), "nft-bids-"));
  const dbPath = join(dir, "test.db");
  const engine = new SqliteEngine({
    dbPath,
    sqliteBusyTimeoutMs: options?.busyTimeoutMs ?? 250,
    lockTimeoutMs: options?.lockTimeoutMs ?? 4000,
    maxConnections: 4,
  });
  engine.boot();
  const fixtures = buildFixtures(options?.seed ?? 20261001);
  await engine.writeTx((db) => {
    ledgerRepo.seed(db, fixtures);
  });
  const logger = new InMemoryDiagLogger();
  const matcher = new Matcher({
    engine,
    logger,
    newRunId: createRunIdFactory("test"),
    newBidId: createIdFactory("bid"),
  });
  const queries = new LedgerQueries(engine);
  return {
    engine,
    matcher,
    queries,
    logger,
    dbPath,
    dir,
    dispose(): void {
      engine.close();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may retain file handles briefly; temp dirs are disposable */ }
    },
  };
}

/** Settled promise exposed as resolve/reject handles for deterministic barriers. */
export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function settled<T>(promise: Promise<T>): Promise<{ status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown }> {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason) => ({ status: "rejected" as const, reason }),
  );
}

export function expectAppError(reason: unknown): { category: string; reason: string; statusCode: number } {
  const record = reason as { category?: string; reason?: string; statusCode?: number };
  if (!record || typeof record.reason !== "string") {
    throw new Error(`expected AppError but received: ${String(reason)}`);
  }
  return { category: String(record.category), reason: record.reason, statusCode: Number(record.statusCode) };
}
