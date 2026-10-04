import {
  CollectionRecord,
  OrderRecord,
  OrderStatus,
  TokenRecord,
  UserRecord,
} from '../contract/types.js';

export type CommitKind =
  | 'listing_create'
  | 'order_cancel'
  | 'order_accept'
  | 'collection_config_update'
  | 'test_ownership_transfer';

export interface ListingInsert {
  collectionId: string;
  tokenId: string;
  seller: string;
  price: number;
  royaltyBpsSnapshot: number;
  royaltyRecipientSnapshot: string;
  soulboundSnapshot: boolean;
}

export interface SettlementResult {
  order: OrderRecord;
  token: TokenRecord;
  affectedUsers: UserRecord[];
  totalBalanceBefore: number;
  totalBalanceAfter: number;
  tokenCountBefore: number;
  tokenCountAfter: number;
  transferEntries: Array<{
    account: string;
    direction: 'debit' | 'credit';
    amount: number;
    classification: string;
  }>;
}

export interface LedgerTransaction {
  readonly runId: string;
  readonly commitSeq: number;

  getCollection(id: string): CollectionRecord | null;
  getUser(id: string): UserRecord | null;
  getToken(collectionId: string, tokenId: string): TokenRecord | null;
  getOrder(id: string): OrderRecord | null;
  findActiveOrder(collectionId: string, tokenId: string): OrderRecord | null;

  insertListing(input: ListingInsert): OrderRecord;
  cancelOrder(order: OrderRecord): void;
  settleOrder(input: {
    order: OrderRecord;
    buyer: string;
    nextOwner: string;
    royaltyRecipient: string;
    royaltyAmount: number;
    sellerProceeds: number;
    detail: Record<string, unknown>;
  }): SettlementResult;

  updateCollectionRoyalty(input: {
    collection: CollectionRecord;
    royaltyBps: number;
    reason: string;
  }): CollectionRecord;

  transferTokenForTest(input: {
    token: TokenRecord;
    nextOwner: string;
    reason: string;
  }): TokenRecord;

  totalBalance(): number;
  countTokens(): number;
  appendCommitDetail(detail: Record<string, unknown>): void;
  writeCommitLog(): void;
}

export interface OrderStatusView {
  id: string;
  status: OrderStatus;
}