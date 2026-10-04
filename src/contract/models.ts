export type BidStatus = "active" | "filled" | "cancelled";

export interface RoyaltyRecipient {
  readonly userId: string;
  readonly weight: number;
}

export interface CollectionRow {
  readonly collectionId: string;
  readonly royaltyBps: number;
  readonly recipients: readonly RoyaltyRecipient[];
  readonly version: number;
}

export interface TokenRow {
  readonly tokenId: string;
  readonly collectionId: string;
  readonly ownerId: string;
}

export interface AccountRow {
  readonly userId: string;
  readonly availableBalance: number;
  readonly frozenBalance: number;
}

export interface BidRow {
  readonly bidId: string;
  readonly collectionId: string;
  readonly bidderId: string;
  readonly amount: number;
  readonly status: BidStatus;
  readonly royaltyBpsSnapshot: number;
  readonly recipientsSnapshot: readonly RoyaltyRecipient[];
  readonly createdCommitSeq: number;
  readonly filledCommitSeq: number | null;
  readonly cancelledCommitSeq: number | null;
  readonly fillTokenId: string | null;
  readonly fillSellerId: string | null;
  readonly sellerAmount: number | null;
  readonly royaltyAmount: number | null;
}

export interface RoyaltyPaymentRow {
  readonly commitSeq: number;
  readonly bidId: string;
  readonly payeeUserId: string;
  readonly amount: number;
}

export interface CreateBidInput {
  readonly kind: "create_bid";
  readonly bidderId: string;
  readonly collectionId: string;
  readonly amount: number;
}

export interface CancelBidInput {
  readonly kind: "cancel_bid";
  readonly bidId: string;
  readonly requesterId: string;
}

export interface AcceptBidInput {
  readonly kind: "accept_bid";
  readonly bidId: string;
  readonly sellerId: string;
  readonly tokenId: string;
}
