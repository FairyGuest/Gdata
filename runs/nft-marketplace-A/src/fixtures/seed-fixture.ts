/**
 * Fixed local synthetic ledger seed. No external accounts or clock-derived
 * values are used. The seeded soulbound order is an explicit legacy canary:
 * normal listing cannot create it, but accept must still enforce policy.
 */

import { BPS_MAX } from '../contract/primitives.js';

export interface SeedCollection {
  id: string;
  royaltyBps: number;
  royaltyRecipient: string;
  soulbound: boolean;
}

export interface SeedToken {
  collectionId: string;
  tokenId: string;
  owner: string;
}

export interface SeedOrder {
  id: string;
  collectionId: string;
  tokenId: string;
  seller: string;
  price: number;
  soulboundSnapshot: boolean;
}

export interface SeedFixture {
  users: Record<string, number>;
  collections: SeedCollection[];
  tokens: SeedToken[];
  orders: SeedOrder[];
}

export const SEED_FIXTURE: SeedFixture = {
  users: {    'u-alice': 100_000,
    'u-bob': 100_000,
    'u-carol': 100_000,
    'u-dave': 100_000,
    'u-broke': 5,
    'u-treasury': 0,
    'u-soul-treasury': 0,
  },
  collections: [
    {
      id: 'col-art',
      royaltyBps: 250,
      royaltyRecipient: 'u-treasury',
      soulbound: false,
    },
    {
      id: 'col-soul',
      royaltyBps: 500,
      royaltyRecipient: 'u-soul-treasury',
      soulbound: true,
    },
    {
      id: 'col-zero-royalty',
      royaltyBps: 0,
      royaltyRecipient: 'u-treasury',
      soulbound: false,
    },
  ],
  tokens: [
    { collectionId: 'col-art', tokenId: 'tok-royalty', owner: 'u-alice' },
    { collectionId: 'col-art', tokenId: 'tok-cancel', owner: 'u-alice' },
    { collectionId: 'col-art', tokenId: 'tok-non-creator', owner: 'u-alice' },
    { collectionId: 'col-art', tokenId: 'tok-concurrent', owner: 'u-alice' },
    { collectionId: 'col-art', tokenId: 'tok-move', owner: 'u-alice' },
    { collectionId: 'col-art', tokenId: 'tok-poor-buyer', owner: 'u-alice' },
    { collectionId: 'col-art', tokenId: 'tok-conservation', owner: 'u-alice' },
    { collectionId: 'col-soul', tokenId: 'tok-soul', owner: 'u-alice' },
    { collectionId: 'col-zero-royalty', tokenId: 'tok-zero', owner: 'u-bob' },
  ],
  orders: [
    {
      id: 'ord-seeded-soul',
      collectionId: 'col-soul',
      tokenId: 'tok-soul',
      seller: 'u-alice',
      price: 1_000,
      soulboundSnapshot: true,
    },
  ],
};

export const FIXED_SEED_ID = 'seed-2026-10-01-fixed-v1';
export { BPS_MAX as FIXTURE_BPS_LIMIT };
