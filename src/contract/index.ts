import { InputError, ConflictError } from "../errors.js";
import type { Ledger, BidRow } from "../state/db.js";

/**
 * Contract layer: turns raw HTTP payloads into typed, validated commands.
 * Owns 422 input errors (shape, price, asset existence, token/collection
 * membership) and the preliminary seller-ownership check. The kernel
 * re-validates every state-dependent fact inside the commit transaction.
 */

export interface CreateBidCommand {
  bidderId: string;
  collectionId: string;
  price: number;
}

export interface CancelBidCommand {
  bidId: string;
  actorId: string;
  /** Bid state observed during contract validation, for race reporting. */
  observed: BidRow;
}

export interface AcceptBidCommand {
  bidId: string;
  sellerId: string;
  tokenId: string;
  observed: BidRow;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InputError("invalid_body", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new InputError("invalid_field", "field " + field + " must be a non-empty string", {
      field,
    });
  }
  return value;
}

function requirePrice(obj: Record<string, unknown>, field: string): number {
  const value = obj[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new InputError("invalid_price", "price must be a positive integer", {
      field,
      value,
    });
  }
  return value;
}

function requireBid(ledger: Ledger, bidId: string): BidRow {
  const bid = ledger.getBid(bidId);
  if (!bid) {
    throw new InputError("unknown_bid", "bid does not exist", { bidId });
  }
  return bid;
}

export function parseCreateBid(body: unknown, ledger: Ledger): CreateBidCommand {
  const obj = asObject(body);
  const bidderId = requireString(obj, "bidderId");
  const collectionId = requireString(obj, "collectionId");
  const price = requirePrice(obj, "price");
  if (!ledger.getCollection(collectionId)) {
    throw new InputError("unknown_collection", "collection does not exist", { collectionId });
  }
  if (!ledger.getAccount(bidderId)) {
    throw new InputError("unknown_bidder", "bidder account does not exist", { bidderId });
  }
  return { bidderId, collectionId, price };
}

export function parseCancelBid(
  params: unknown,
  body: unknown,
  ledger: Ledger,
): CancelBidCommand {
  const p = asObject(params);
  const bidId = requireString(p, "bidId");
  const obj = body === undefined || body === null ? {} : asObject(body);
  const actorId = requireString(obj, "actorId");
  const observed = requireBid(ledger, bidId);
  return { bidId, actorId, observed };
}

export function parseAcceptBid(
  params: unknown,
  body: unknown,
  ledger: Ledger,
): AcceptBidCommand {
  const p = asObject(params);
  const bidId = requireString(p, "bidId");
  const obj = asObject(body);
  const sellerId = requireString(obj, "sellerId");
  const tokenId = requireString(obj, "tokenId");
  const observed = requireBid(ledger, bidId);
  const token = ledger.getToken(tokenId);
  if (!token) {
    throw new InputError("unknown_token", "token does not exist", { tokenId });
  }
  if (token.collectionId !== observed.collectionId) {
    throw new InputError("token_not_in_collection", "token does not belong to the bid collection", {
      tokenId,
      tokenCollectionId: token.collectionId,
      bidCollectionId: observed.collectionId,
    });
  }
  if (token.ownerId !== sellerId) {
    throw new ConflictError("seller_not_token_owner", "seller does not hold this token", {
      tokenId,
      sellerId,
      currentOwnerId: token.ownerId,
    });
  }
  return { bidId, sellerId, tokenId, observed };
}
