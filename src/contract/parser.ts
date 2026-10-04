import { inputError } from "./errors.js";
import type { AcceptBidInput, CancelBidInput, CreateBidInput } from "./models.js";

function asObject(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      throw inputError("malformed_body", "request body must be a JSON object");
    }
    throw inputError("malformed_body", "request body must be a JSON object");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw inputError("malformed_body", "request body must be a JSON object");
  }
  return raw as Record<string, unknown>;
}

function requiredId(record: Record<string, unknown>, field: string): string {
  if (!(field in record) || record[field] === undefined || record[field] === null) {
    throw inputError("missing_field", `field "${field}" is required`, { field });
  }
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw inputError("missing_field", `field "${field}" must be a non-empty string`, { field });
  }
  return value.trim();
}

function requiredPrice(record: Record<string, unknown>, field = "amount"): number {
  if (!(field in record) || record[field] === undefined || record[field] === null) {
    throw inputError("missing_field", `field "${field}" is required`, { field });
  }
  const value = record[field];
  const isIntegerShape =
    typeof value === "number"
      ? Number.isInteger(value)
      : typeof value === "string" && /^\d+$/.test(value.trim());
  if (!isIntegerShape) {
    throw inputError("price_not_positive_integer", `field "${field}" must be a positive integer`, {
      field,
      received: String(value),
    });
  }
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw inputError("price_not_positive_integer", `field "${field}" must be a positive integer`, {
      field,
      received: String(value),
    });
  }
  return amount;
}

export function parseCreateBid(raw: unknown): CreateBidInput {
  const record = asObject(raw);
  return {
    kind: "create_bid",
    bidderId: requiredId(record, "bidderId"),
    collectionId: requiredId(record, "collectionId"),
    amount: requiredPrice(record, "amount"),
  };
}

export function parseCancelBid(bidId: string | undefined, raw: unknown): CancelBidInput {
  if (typeof bidId !== "string" || bidId.trim() === "") {
    throw inputError("missing_field", 'path parameter "bidId" is required', { field: "bidId" });
  }
  const record = asObject(raw);
  return {
    kind: "cancel_bid",
    bidId: bidId.trim(),
    requesterId: requiredId(record, "requesterId"),
  };
}

export function parseAcceptBid(bidId: string | undefined, raw: unknown): AcceptBidInput {
  if (typeof bidId !== "string" || bidId.trim() === "") {
    throw inputError("missing_field", 'path parameter "bidId" is required', { field: "bidId" });
  }
  const record = asObject(raw);
  return {
    kind: "accept_bid",
    bidId: bidId.trim(),
    sellerId: requiredId(record, "sellerId"),
    tokenId: requiredId(record, "tokenId"),
  };
}

export function parseRoyaltyUpdate(
  raw: unknown,
): { royaltyBps: number; recipients: Array<{ userId: string; weight: number }> } {
  const record = asObject(raw);
  if (!("royaltyBps" in record) || record.royaltyBps === undefined || record.royaltyBps === null) {
    throw inputError("missing_field", 'field "royaltyBps" is required', { field: "royaltyBps" });
  }
  const bpsRaw = record.royaltyBps;
  if (typeof bpsRaw !== "number" || !Number.isInteger(bpsRaw) || bpsRaw < 0 || bpsRaw > 10000) {
    throw inputError("price_not_positive_integer", 'field "royaltyBps" must be an integer between 0 and 10000', {
      field: "royaltyBps",
      received: String(bpsRaw),
    });
  }
  const royaltyBps = bpsRaw;
  const rawRecipients = record.recipients;
  if (!Array.isArray(rawRecipients) || rawRecipients.length === 0) {
    throw inputError("missing_field", "field \"recipients\" must be a non-empty array", {
      field: "recipients",
    });
  }
  const recipients = rawRecipients.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw inputError("missing_field", `recipients[${index}] must be an object`, { index });
    }
    const item = entry as Record<string, unknown>;
    const userId = requiredId(item, "userId");
    if (typeof item.weight !== "number" || !Number.isSafeInteger(item.weight) || item.weight <= 0) {
      throw inputError("price_not_positive_integer", `recipients[${index}].weight must be a positive integer`, {
        index,
      });
    }
    return { userId, weight: item.weight };
  });
  return { royaltyBps, recipients };
}
