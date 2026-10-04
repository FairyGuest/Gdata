// Independent reference projection, used ONLY by tests and the acceptance
// script as an oracle. It deliberately shares no code with src/state or
// src/kernel, so a bug in the engine cannot reproduce itself in the answer.

import type { NftEvent } from '../contract/events.ts';

export interface ReferenceProjection {
  appliedSeq: number;
  owners: Record<string, string>;
  volume: number;
  floor: number | null;
  salesCount: number;
  lastSale: Record<string, { seq: number; price: number; from: string; to: string }>;
}

export function referenceProjection(events: NftEvent[], toSeq?: number): ReferenceProjection {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const limit = toSeq ?? (sorted.length ? (sorted[sorted.length - 1] as NftEvent).seq : 0);
  const proj: ReferenceProjection = {
    appliedSeq: 0,
    owners: {},
    volume: 0,
    floor: null,
    salesCount: 0,
    lastSale: {},
  };
  for (const ev of sorted) {
    if (ev.seq > limit) break;
    if (ev.type === 'mint') {
      proj.owners[ev.tokenId] = ev.to;
    } else {
      proj.owners[ev.tokenId] = ev.to;
    }
    if (ev.type === 'sale') {
      const price = ev.price as number;
      proj.volume += price;
      proj.floor = proj.floor === null ? price : Math.min(proj.floor, price);
      proj.salesCount += 1;
      proj.lastSale[ev.tokenId] = { seq: ev.seq, price, from: ev.from as string, to: ev.to };
    }
    proj.appliedSeq = ev.seq;
  }
  return proj;
}

// Key-order-independent canonical serialization for bitwise comparisons
// between projections produced by different paths.
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (typeof value === 'object' && value !== null) {
    const rec = value as Record<string, unknown>;
    return '{' + Object.keys(rec).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(rec[k])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}