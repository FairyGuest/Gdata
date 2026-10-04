import type { TransactionHooks } from "../state/sqlite-engine.js";
import type { BidRow } from "../contract/models.js";

export interface OperationOptions {
  readonly runId?: string;
  readonly hooks?: TransactionHooks;
}

export interface CreateBidResult {
  readonly outcome: "created";
  readonly runId: string;
  readonly commitSeq: number;
  readonly bid: BidRow;
  readonly frozenAmount: number;
  readonly bidderBalances: { readonly available: number; readonly frozen: number };
  readonly decisionBasis: string;
}

export interface CancelBidResult {
  readonly outcome: "cancelled";
  readonly runId: string;
  readonly commitSeq: number;
  readonly bidId: string;
  readonly unfrozenAmount: number;
  readonly bidderBalances: { readonly available: number; readonly frozen: number };
  readonly decisionBasis: string;
}

export interface AcceptBidResult {
  readonly outcome: "filled";
  readonly runId: string;
  readonly commitSeq: number;
  readonly bidId: string;
  readonly collectionId: string;
  readonly tokenId: string;
  readonly sellerId: string;
  readonly newOwnerId: string;
  readonly price: number;
  readonly sellerAmount: number;
  readonly royaltyAmount: number;
  readonly royaltyBpsSnapshot: number;
  readonly splits: ReadonlyArray<{ readonly userId: string; readonly amount: number }>;
  readonly postBalances: ReadonlyArray<{ readonly userId: string; readonly available: number; readonly frozen: number }>;
  readonly decisionBasis: string;
}

export interface RoyaltyUpdateResult {
  readonly outcome: "royalty_updated";
  readonly runId: string;
  readonly commitSeq: number;
  readonly collectionId: string;
  readonly royaltyBps: number;
  readonly version: number;
}
