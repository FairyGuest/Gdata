import type { FastifyInstance } from 'fastify';
import { Journal } from '../src/diag/journal.ts';
import { bootstrapLedger } from '../src/fixtures/seed.ts';
import type { FixtureManifest } from '../src/fixtures/seed.ts';
import { buildApp } from '../src/http/app.ts';
import { MarketEngine } from '../src/kernel/engine.ts';
import { Ledger } from '../src/state/ledger.ts';

export interface TestContext {
  ledger: Ledger;
  journal: Journal;
  engine: MarketEngine;
  app: FastifyInstance;
  runId: string;
  manifest: FixtureManifest;
}

export function createTestContext(seed = 1337): TestContext {
  const ledger = new Ledger(':memory:');
  const { runId, manifest } = bootstrapLedger(ledger, seed);
  const journal = new Journal(ledger, runId);
  const engine = new MarketEngine(ledger, journal);
  const app = buildApp({ ledger, engine, journal, runId });
  return { ledger, journal, engine, app, runId, manifest };
}

export function seededBalance(ctx: TestContext, userId: string): number {
  const user = ctx.manifest.users.find((u) => u.id === userId);
  if (!user) throw new Error('no such fixture user: ' + userId);
  return user.balance;
}

export interface ApiError {
  category: string;
  reason: string;
  message: string;
  details: unknown;
  runId: string;
  requestId: string;
}

export function errorBody(res: { body: string }): ApiError {
  return (JSON.parse(res.body) as { error: ApiError }).error;
}
