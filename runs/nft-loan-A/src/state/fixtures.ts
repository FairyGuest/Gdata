// Deterministic synthetic fixtures generated from a fixed seed description.
// No randomness, no external data: balances and valuation tick-ladders are literal tables.

export interface SeedInput {
  balances: Record<string, number>;
  nftHolders: Record<string, string>;
  valuationLadders: Record<string, Array<{ startTick: number; value: number }>>;
}

export const LENDER_POOL = 'lender-pool';

export const FIXTURE_SEED: SeedInput = {
  balances: {
    alice: 5000,
    [LENDER_POOL]: 100000,
  },
  nftHolders: {
    'NFT-ALPHA': 'alice',
    'NFT-BETA': 'alice',
    'NFT-GAMMA': 'alice',
    'NFT-DELTA': 'alice',
    'NFT-F1': 'alice',
    'NFT-F2': 'alice',
    'NFT-F3': 'alice',
    'NFT-F4': 'alice',
    'NFT-F5': 'alice',
    'NFT-F6': 'alice',
  },
  valuationLadders: {
    // Stable ladders.
    'NFT-ALPHA': [{ startTick: 0, value: 1000 }],
    'NFT-BETA': [{ startTick: 0, value: 1000 }],
    'NFT-GAMMA': [{ startTick: 0, value: 2000 }],
    'NFT-F1': [{ startTick: 0, value: 100 }],
    'NFT-F2': [{ startTick: 0, value: 100 }],
    'NFT-F3': [{ startTick: 0, value: 100 }],
    'NFT-F4': [{ startTick: 0, value: 100 }],
    'NFT-F5': [{ startTick: 0, value: 100 }],
    'NFT-F6': [{ startTick: 0, value: 100 }],
    // DELTA collapses through the liquidation line once tick >= 10.
    'NFT-DELTA': [
      { startTick: 0, value: 1000 },
      { startTick: 10, value: 700 },
    ],
  },
};
