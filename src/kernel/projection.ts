import { conflict } from "./errors.ts";
import type { NftEvent } from "../contract/types.ts";

export interface LastSale {
  seq: number;
  tokenId: string;
  price: number;
  from: string;
  to: string;
}

export interface Projection {
  appliedSeq: number;
  ownership: Record<string, string>;
  volume: number;
  floor: number | null;
  lastSale: LastSale | null;
}

export function emptyProjection(): Projection {
  return {
    appliedSeq: 0,
    ownership: {},
    volume: 0,
    floor: null,
    lastSale: null,
  };
}

export function cloneProjection(p: Projection): Projection {
  return {
    appliedSeq: p.appliedSeq,
    ownership: { ...p.ownership },
    volume: p.volume,
    floor: p.floor,
    lastSale: p.lastSale ? { ...p.lastSale } : null,
  };
}

function applyOne(p: Projection, event: NftEvent): Projection {
  if (event.seq !== p.appliedSeq + 1) {
    throw conflict(
      "event_gap",
      `expected seq ${p.appliedSeq + 1} but received ${event.seq}`,
      { expectedSeq: p.appliedSeq + 1, receivedSeq: event.seq, appliedSeq: p.appliedSeq }
    );
  }

  const next = cloneProjection(p);

  switch (event.type) {
    case "mint": {
      next.ownership[event.tokenId] = event.to;
      break;
    }
    case "transfer": {
      const owner = next.ownership[event.tokenId];
      if (owner !== event.from) {
        throw conflict(
          "invalid_transition",
          `transfer from "${event.from}" is not the current owner of "${event.tokenId}"`,
          { tokenId: event.tokenId, from: event.from, currentOwner: owner ?? null }
        );
      }
      next.ownership[event.tokenId] = event.to;
      break;
    }
    case "sale": {
      const owner = next.ownership[event.tokenId];
      if (owner !== event.from) {
        throw conflict(
          "invalid_transition",
          `sale from "${event.from}" is not the current owner of "${event.tokenId}"`,
          { tokenId: event.tokenId, from: event.from, currentOwner: owner ?? null }
        );
      }
      next.ownership[event.tokenId] = event.to;
      next.volume += event.price;
      next.floor = next.floor === null ? event.price : Math.min(next.floor, event.price);
      next.lastSale = {
        seq: event.seq,
        tokenId: event.tokenId,
        price: event.price,
        from: event.from,
        to: event.to,
      };
      break;
    }
  }

  next.appliedSeq = event.seq;
  return next;
}

export function applyEvent(p: Projection, event: NftEvent): Projection {
  return applyOne(p, event);
}

export function applyEvents(p: Projection, events: NftEvent[]): Projection {
  return events.reduce((acc, event) => applyOne(acc, event), p);
}

