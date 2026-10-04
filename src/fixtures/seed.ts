import { parseCollectionConfig } from '../contract/parse.ts';
import type { CollectionConfig } from '../contract/parse.ts';
import type { Ledger } from '../state/ledger.ts';

export interface FixtureUser {
  id: string;
  balance: number;
}

export interface FixtureToken {
  id: string;
  collectionId: string;
  ownerId: string;
}

export interface FixtureManifest {
  seed: number;
  users: FixtureUser[];
  collections: CollectionConfig[];
  tokens: FixtureToken[];
  expectedBalanceSum: number;
}

/** Deterministic PRNG (mulberry32) so fixtures are reproducible from the seed. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildFixtures(seed: number): FixtureManifest {
  const rnd = mulberry32(seed);
  const between = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));

  const collections: CollectionConfig[] = [
    { id: 'col-art', name: 'Generative Art', royaltyBps: 250, royaltyRecipient: 'acct-royalty-art', soulbound: false },
    { id: 'col-zero', name: 'Zero Royalty Club', royaltyBps: 0, royaltyRecipient: 'acct-royalty-zero', soulbound: false },
    { id: 'col-soul', name: 'Soulbound Badges', royaltyBps: 500, royaltyRecipient: 'acct-royalty-soul', soulbound: true },
  ].map((raw) => parseCollectionConfig(raw));

  const users: FixtureUser[] = [
    { id: 'alice', balance: between(2000, 2500) },
    { id: 'bob', balance: between(3000, 3500) },
    { id: 'carol', balance: between(3000, 3500) },
    { id: 'dave', balance: between(40, 60) },
    { id: 'acct-royalty-art', balance: 0 },
    { id: 'acct-royalty-zero', balance: 0 },
    { id: 'acct-royalty-soul', balance: 0 },
  ];

  const tokens: FixtureToken[] = [
    { id: 'art-1', collectionId: 'col-art', ownerId: 'alice' },
    { id: 'art-2', collectionId: 'col-art', ownerId: 'alice' },
    { id: 'art-3', collectionId: 'col-art', ownerId: 'bob' },
    { id: 'art-4', collectionId: 'col-art', ownerId: 'carol' },
    { id: 'zero-1', collectionId: 'col-zero', ownerId: 'alice' },
    { id: 'soul-1', collectionId: 'col-soul', ownerId: 'alice' },
    { id: 'soul-2', collectionId: 'col-soul', ownerId: 'bob' },
  ];

  const expectedBalanceSum = users.reduce((acc, user) => acc + user.balance, 0);
  return { seed, users, collections, tokens, expectedBalanceSum };
}

export function applyFixtures(ledger: Ledger, manifest: FixtureManifest): void {
  ledger.tx(() => {
    for (const collection of manifest.collections) ledger.insertCollection(collection);
    for (const user of manifest.users) ledger.insertUser(user);
    for (const token of manifest.tokens) ledger.insertToken(token);
    ledger.setMeta('seed', String(manifest.seed));
    ledger.setMeta('expected_balance_sum', String(manifest.expectedBalanceSum));
    ledger.setMeta('order_seq', '0');
    ledger.setMeta('commit_seq', '0');
    ledger.setMeta('boot_seq', '0');
  });
}

export interface BootResult {
  runId: string;
  manifest: FixtureManifest;
}

/**
 * Seeds the ledger on first boot (fixed seed -> deterministic ledger) and
 * allocates a run id from a persisted boot counter, so every process run is
 * distinguishable in the diag journal.
 */
export function bootstrapLedger(ledger: Ledger, seed: number): BootResult {
  const existingSeed = ledger.getMeta('seed');
  let manifest: FixtureManifest;
  if (existingSeed === undefined) {
    manifest = buildFixtures(seed);
    applyFixtures(ledger, manifest);
  } else {
    manifest = buildFixtures(Number(existingSeed));
  }
  const bootSeq = ledger.tx(() => ledger.nextSeq('boot_seq'));
  const runId = 'run-' + String(manifest.seed) + '-' + String(bootSeq);
  ledger.setMeta('last_run_id', runId);
  return { runId, manifest };
}
