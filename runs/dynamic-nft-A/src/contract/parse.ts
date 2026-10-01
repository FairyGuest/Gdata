import { invalid } from "./errors.js";

export interface FeedRequest {
  collectionId: string;
  tokenId: string;
  amount: number;
}

export interface ResetRequest {
  collectionId: string;
  tokenId: string;
  adminId: string;
}

export interface MetadataRequest {
  collectionId: string;
  tokenId: string;
}

export const MAX_XP_PER_FEED = 1_000_000;

function requireId(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw invalid("missing_identifier", { field, received: raw });
  }
  if (!/^[A-Za-z0-9:_-]{1,64}$/.test(raw)) {
    throw invalid("malformed_identifier", { field, received: raw });
  }
  return raw;
}

export function parseFeed(body: unknown): FeedRequest {
  if (typeof body !== "object" || body === null) {
    throw invalid("invalid_body", { received: body });
  }
  const b = body as Record<string, unknown>;
  const collectionId = requireId(b.collectionId, "collectionId");
  const tokenId = requireId(b.tokenId, "tokenId");
  const amount = b.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw invalid("invalid_xp_amount", { field: "amount", received: amount });
  }
  if (!Number.isInteger(amount)) {
    throw invalid("xp_amount_not_integer", { field: "amount", received: amount });
  }
  if (amount <= 0) {
    throw invalid("xp_amount_not_positive", { field: "amount", received: amount });
  }
  if (amount > MAX_XP_PER_FEED) {
    throw invalid("xp_amount_too_large", { field: "amount", received: amount, max: MAX_XP_PER_FEED });
  }
  return { collectionId, tokenId, amount };
}

export function parseReset(body: unknown, headers: Record<string, unknown>): ResetRequest {
  if (typeof body !== "object" || body === null) {
    throw invalid("invalid_body", { received: body });
  }
  const b = body as Record<string, unknown>;
  const collectionId = requireId(b.collectionId, "collectionId");
  const tokenId = requireId(b.tokenId, "tokenId");
  const rawAdmin = headers["x-admin-id"];
  if (typeof rawAdmin !== "string" || rawAdmin.trim() === "") {
    throw invalid("missing_admin_credentials", { header: "x-admin-id" });
  }
  const adminId = requireId(rawAdmin, "x-admin-id");
  return { collectionId, tokenId, adminId };
}

export function parseMetadata(params: Record<string, unknown>): MetadataRequest {
  return {
    collectionId: requireId(params.collectionId, "collectionId"),
    tokenId: requireId(params.tokenId, "tokenId"),
  };
}
