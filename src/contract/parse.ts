import { inputError, resourceExhausted } from "./errors.js";

export interface FeedParams {
  tokenId: number;
  amount: number;
}

export interface ResetParams {
  tokenId: number;
  adminId: string;
}

function parseTokenId(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw inputError("invalid_token_id", "token id must be a positive integer, got: " + String(raw));
  }
  return n;
}

/** Parse and validate a feed request body. */
export function parseFeed(body: unknown, maxFeedAmount: number): FeedParams {
  if (typeof body !== "object" || body === null) {
    throw inputError("invalid_body", "feed body must be a JSON object");
  }
  const { tokenId, amount } = body as Record<string, unknown>;
  const id = parseTokenId(tokenId);
  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt <= 0) {
    throw inputError("invalid_xp_amount", "feed amount must be a positive integer, got: " + String(amount));
  }
  if (amt > maxFeedAmount) {
    throw resourceExhausted("feed_amount_exceeds_capacity", "amount " + amt + " exceeds capacity " + maxFeedAmount);
  }
  return { tokenId: id, amount: amt };
}

/** Parse and validate a reset request (admin id comes from x-admin-id header). */
export function parseReset(body: unknown, adminHeader: unknown): ResetParams {
  if (typeof body !== "object" || body === null) {
    throw inputError("invalid_body", "reset body must be a JSON object");
  }
  const { tokenId } = body as Record<string, unknown>;
  const id = parseTokenId(tokenId);
  if (typeof adminHeader !== "string" || adminHeader.length === 0) {
    throw inputError("missing_admin_id", "x-admin-id header is required");
  }
  return { tokenId: id, adminId: adminHeader };
}

/** Parse a token id path parameter for metadata/diag queries. */
export function parseTokenParam(raw: unknown): number {
  return parseTokenId(raw);
}
