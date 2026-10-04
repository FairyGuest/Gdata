import type { BidRow, CollectionRow, TokenRow } from "./models.js";
import { conflictError, inputError } from "./errors.js";

/**
 * Read-only ledger port. The contract layer never mutates state and never
 * depends on SQLite types directly; the state adapter implements this port.
 */
export interface LedgerReadPort {
  findCollection(collectionId: string): CollectionRow | null;
  findToken(tokenId: string): TokenRow | null;
  findBid(bidId: string): BidRow | null;
  findAccount(userId: string): { readonly userId: string } | null;
}

export interface ValidatedCreate {
  readonly collection: CollectionRow;
}

export interface ValidatedCancel {
  readonly bid: BidRow;
}

export interface ValidatedAccept {
  readonly bid: BidRow;
  readonly token: TokenRow;
}

export function requireAccount(port: LedgerReadPort, userId: string): void {
  if (!port.findAccount(userId)) {
    throw inputError("unknown_user", "user does not exist", { userId });
  }
}

export function validateCreate(port: LedgerReadPort, input: { bidderId: string; collectionId: string }): ValidatedCreate {
  if (!port.findAccount(input.bidderId)) {
    throw inputError("unknown_user", "bidder user does not exist", { userId: input.bidderId });
  }
  const collection = port.findCollection(input.collectionId);
  if (!collection) {
    throw inputError("unknown_collection", "collection does not exist", { collectionId: input.collectionId });
  }
  return { collection };
}

export function validateBidExists(port: LedgerReadPort, bidId: string): BidRow {
  const bid = port.findBid(bidId);
  if (!bid) {
    throw inputError("unknown_bid", "bid does not exist", { bidId });
  }
  return bid;
}

export function validateCancel(port: LedgerReadPort, input: { bidId: string }): ValidatedCancel {
  return { bid: validateBidExists(port, input.bidId) };
}

export function validateAccept(
  port: LedgerReadPort,
  input: { bidId: string; tokenId: string },
): ValidatedAccept {
  const bid = validateBidExists(port, input.bidId);
  const token = port.findToken(input.tokenId);
  if (!token) {
    throw inputError("unknown_token", "token does not exist", { tokenId: input.tokenId });
  }
  if (token.collectionId !== bid.collectionId) {
    throw inputError("token_not_in_collection", "token does not belong to the bid collection", {
      bidId: bid.bidId,
      tokenId: token.tokenId,
      bidCollectionId: bid.collectionId,
      tokenCollectionId: token.collectionId,
    });
  }
  return { bid, token };
}

/** Ownership predicate shared by preflight checks and the in-transaction check. */
export function assertSellerOwnsToken(token: TokenRow, sellerId: string): void {
  if (token.ownerId !== sellerId) {
    throw conflictError("seller_does_not_own_token", "seller no longer holds the token", {
      tokenId: token.tokenId,
      sellerId,
      currentOwnerId: token.ownerId,
    });
  }
}
