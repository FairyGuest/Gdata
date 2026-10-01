/**
 * Shared data contract between the contract / state / kernel layers.
 * These are plain immutable value objects; no SQLite or HTTP types leak here.
 */

export interface CollectionRecord {
  id: string;
  royaltyBps: number;
  royaltyRecipient: string;
  soulbound: boolean;
  version: number;
}

export interface TokenRecord {
  id: string;
  collectionId: string;
  owner: string;
}

export interface UserRecord {
  id: string;
  balance: number;
}

export type OrderStatus = 'active' | 'filled' | 'cancelled';

export interface OrderRecord {
  id: string;
  collectionId: string;
  tokenId: string;
  seller: string;
  buyer: string | null;
  price: number;
  status: OrderStatus;
  royaltyBpsSnapshot: number;
  royaltyRecipientSnapshot: string;
  soulboundSnapshot: boolean;
  createdCommitSeq: number;
  filledCommitSeq: number | null;
  cancelledCommitSeq: number | null;
}

/** Read-only asset directory port implemented by the state layer. */
export interface AssetDirectory {
  findCollection(id: string): CollectionRecord | null;
  findToken(collectionId: string, tokenId: string): TokenRecord | null;
  findUser(id: string): UserRecord | null;
  findOrder(id: string): OrderRecord | null;
}

export interface CreateListingInput {
  collectionId: string;
  tokenId: string;
  sellerId: string;
  price: number;
}

export interface CancelOrderInput {
  orderId: string;
  requesterId: string;
}

export interface AcceptOrderInput {
  orderId: string;
  buyerId: string;
}

export interface RoyaltySplit {
  grossPrice: number;
  royaltyBps: number;
  royaltyAmount: number;
  sellerProceeds: number;
}