import type { NftEvent, SaleEvent, TransferEvent, MintEvent } from "../src/contract/types.ts";

// Deterministic PRNG (mulberry32) so fixtures are reproducible from a fixed seed.
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

const WALLETS = ["alice", "bob", "carol", "dave", "erin"];

export interface CanonicalStream {
  events: NftEvent[];
  prices: number[];
}

// A hand-authored canonical scenario with known expected projections.
// seq 1 mint T1 -> alice
// seq 2 sale T1 alice->bob @100
// seq 3 mint T2 -> carol
// seq 4 transfer T2 carol->dave
// seq 5 sale T1 bob->carol @40   (new floor 40)
// seq 6 sale T2 dave->erin @200
// seq 7 transfer T1 carol->alice
// seq 8 sale T2 erin->bob @30    (new floor 30)
export function buildCanonicalStream(): CanonicalStream {
  const events: NftEvent[] = [
    { seq: 1, type: "mint", tokenId: "T1", to: "alice" } satisfies MintEvent,
    { seq: 2, type: "sale", tokenId: "T1", from: "alice", to: "bob", price: 100 } satisfies SaleEvent,
    { seq: 3, type: "mint", tokenId: "T2", to: "carol" } satisfies MintEvent,
    { seq: 4, type: "transfer", tokenId: "T2", from: "carol", to: "dave" } satisfies TransferEvent,
    { seq: 5, type: "sale", tokenId: "T1", from: "bob", to: "carol", price: 40 } satisfies SaleEvent,
    { seq: 6, type: "sale", tokenId: "T2", from: "dave", to: "erin", price: 200 } satisfies SaleEvent,
    { seq: 7, type: "transfer", tokenId: "T1", from: "carol", to: "alice" } satisfies TransferEvent,
    { seq: 8, type: "sale", tokenId: "T2", from: "erin", to: "bob", price: 30 } satisfies SaleEvent,
  ];
  return { events, prices: [100, 40, 200, 30] };
}

export interface DeliveryBatch {
  label: string;
  events: NftEvent[];
}

// Produces an out-of-order / duplicate delivery schedule for the canonical stream.
// Batches are presented in array order; the indexer must reject gaps/dupes but
// stay consistent. The seed is fixed by the caller for reproducibility.
export function buildOutOfOrderBatches(seed = 20261002): {
  batches: DeliveryBatch[];
  stream: CanonicalStream;
  schedule: number[];
} {
  const stream = buildCanonicalStream();
  const rand = mulberry32(seed);

  // Delivery seq order: deliberately out of order with one duplicate.
  // 2,1 (gap rejected first), then 1,2 (applied), 3, 4, 3(dup), 5,6,7,8
  const schedule = [2, 1, 2, 3, 4, 3, 5, 6, 7, 8];
  const events = schedule.map((seq) => {
    const src = stream.events[seq - 1];
    // Deep clone so callers cannot mutate the canonical stream.
    return JSON.parse(JSON.stringify(src)) as NftEvent;
  });

  // Group into labeled batches. Shuffle only within tolerance; order stays as
  // authored to make assertions deterministic (rand used to stamp labels).
  void rand;
  const batches: DeliveryBatch[] = [
    { label: "early-seq2-gap", events: [events[0]] },
    { label: "seq1-then-dup-seq2", events: [events[1], events[2]] },
    { label: "seq3-seq4", events: [events[3], events[4]] },
    { label: "dup-seq3", events: [events[5]] },
    { label: "seq5-8", events: [events[6], events[7], events[8], events[9]] },
  ];
  return { batches, stream, schedule };
}

// An event whose transfer "from" is not the current owner.
export function buildInvalidTransfer(seq = 4): TransferEvent {
  // At seq 4, T2 is owned by carol; a transfer claiming "erin" must be rejected.
  return { seq, type: "transfer", tokenId: "T2", from: "erin", to: "dave" };
}

export { WALLETS };

