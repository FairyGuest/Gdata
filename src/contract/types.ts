export type EventType = "mint" | "transfer" | "sale";

export interface MintEvent {
  seq: number;
  type: "mint";
  tokenId: string;
  to: string;
}

export interface TransferEvent {
  seq: number;
  type: "transfer";
  tokenId: string;
  from: string;
  to: string;
}

export interface SaleEvent {
  seq: number;
  type: "sale";
  tokenId: string;
  from: string;
  to: string;
  price: number;
}

export type NftEvent = MintEvent | TransferEvent | SaleEvent;

export function canonicalEvent(event: NftEvent): string {
  return JSON.stringify(event);
}

