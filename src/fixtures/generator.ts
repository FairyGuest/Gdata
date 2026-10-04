// Synthetic fixtures: fixed-seed event stream plus out-of-order / duplicated
// submission batches. Fully local and deterministic; no clocks, no network.

import type { NftEvent } from '../contract/events.ts';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FIXTURE_SEED = 20261002;

function addr(i: number): string {
  return '0x' + i.toString(16).padStart(40, '0');
}

export const ACTORS = Array.from({ length: 8 }, (_, i) => addr(i + 1));

// Generate a legal-in-sequence stream: mints introduce tokens, later events
// move them between actors; sales carry a deterministic price.
export function generateStream(count: number, seed: number = FIXTURE_SEED): NftEvent[] {
  const rnd = mulberry32(seed);
  const events: NftEvent[] = [];
  const ownerOf = new Map<string, string>();
  let minted = 0;
  for (let seq = 1; seq <= count; seq++) {
    const roll = rnd();
    const tokenIds = [...ownerOf.keys()];
    if (tokenIds.length === 0 || roll < 0.4) {
      const tokenId = 'token-' + ++minted;
      const to = ACTORS[Math.floor(rnd() * ACTORS.length)] as string;
      ownerOf.set(tokenId, to);
      events.push({ seq, type: 'mint', tokenId, from: null, to, price: null });
    } else {
      const tokenId = tokenIds[Math.floor(rnd() * tokenIds.length)] as string;
      const from = ownerOf.get(tokenId) as string;
      let to = ACTORS[Math.floor(rnd() * ACTORS.length)] as string;
      if (to === from) to = ACTORS[(ACTORS.indexOf(to) + 1) % ACTORS.length] as string;
      if (roll < 0.75) {
        const price = 1 + Math.floor(rnd() * 500);
        ownerOf.set(tokenId, to);
        events.push({ seq, type: 'sale', tokenId, from, to, price });
      } else {
        ownerOf.set(tokenId, to);
        events.push({ seq, type: 'transfer', tokenId, from, to, price: null });
      }
    }
  }
  return events;
}

// Deterministic Fisher-Yates with the fixture PRNG.
export function shuffled<T>(items: T[], seed: number): T[] {
  const rnd = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  // Guarantee the order actually changes so fixtures always exercise gaps.
  if (out.length > 1 && out.every((v, i) => v === items[i])) {
    const a = out[0] as T;
    out[0] = out[1] as T;
    out[1] = a;
  }
  return out;
}

// Build a replay workload: the stream chopped into out-of-order batches with
// some events duplicated (idempotent replay) 鈥?exactly what a flaky
// upstream re-delivering batches would look like.
export function makeReplayBatches(stream: NftEvent[], batchSize: number, seed: number = FIXTURE_SEED): NftEvent[][] {
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const batches: NftEvent[][] = [];
  for (let i = 0; i < stream.length; i += batchSize) {
    batches.push(stream.slice(i, i + batchSize));
  }
  const ordered = shuffled(batches, seed ^ 0x51ab);
  return ordered.map((batch) => {
    const withDupes = [...batch];
    for (const ev of batch) {
      if (rnd() < 0.25) withDupes.push({ ...ev });
    }
    // Keep in-batch order (contiguous delivery); duplicates ride along.
    return withDupes;
  });
}

// Same seq, different content 鈥?must be rejected as duplicate_event, never
// silently overwrite the logged event.
export function makeConflicting(ev: NftEvent): NftEvent {
  return { ...ev, to: ACTORS[(ACTORS.indexOf(ev.to) + 3) % ACTORS.length] as string };
}
