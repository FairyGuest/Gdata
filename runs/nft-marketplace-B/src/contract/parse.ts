import { inputError } from './errors.ts';

export interface CollectionConfig {
  id: string;
  name: string;
  royaltyBps: number;
  royaltyRecipient: string;
  soulbound: boolean;
}

export interface TokenRecord {
  id: string;
  collectionId: string;
  ownerId: string;
}

/** Read-only catalog view the contract layer uses for existence checks. */
export interface CatalogView {
  getCollection(id: string): CollectionConfig | undefined;
  getToken(id: string): TokenRecord | undefined;
  userExists(id: string): boolean;
}

export interface ListParams {
  tokenId: string;
  sellerId: string;
  price: number;
}

export interface CancelParams {
  orderId: string;
  actorId: string;
}

export interface AcceptParams {
  orderId: string;
  buyerId: string;
}

function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw inputError('invalid_body', 'request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw inputError('missing_field', 'field "' + field + '" must be a non-empty string', { field });
  }
  return value;
}

export function requirePrice(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || !Number.isSafeInteger(value)) {
    throw inputError('invalid_price', 'price must be a positive safe integer', { value });
  }
  return value;
}

export function requireBps(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10000) {
    throw inputError('invalid_bps', 'bps must be an integer within [0, 10000]', { value });
  }
  return value;
}

/** Validates a collection configuration (used when loading fixtures / config). */
export function parseCollectionConfig(raw: unknown): CollectionConfig {
  const obj = requireObject(raw);
  const id = requireString(obj, 'id');
  const name = requireString(obj, 'name');
  const royaltyBps = requireBps(obj['royaltyBps']);
  const royaltyRecipient = requireString(obj, 'royaltyRecipient');
  const soulbound = obj['soulbound'];
  if (typeof soulbound !== 'boolean') {
    throw inputError('missing_field', 'field "soulbound" must be a boolean', { field: 'soulbound' });
  }
  return { id, name, royaltyBps, royaltyRecipient, soulbound };
}

export function parseListParams(body: unknown, catalog: CatalogView): ListParams {
  const obj = requireObject(body);
  const tokenId = requireString(obj, 'tokenId');
  const sellerId = requireString(obj, 'sellerId');
  const price = requirePrice(obj['price']);
  const token = catalog.getToken(tokenId);
  if (!token) {
    throw inputError('unknown_token', 'unknown token "' + tokenId + '"', { tokenId });
  }
  if (!catalog.getCollection(token.collectionId)) {
    throw inputError('unknown_collection', 'unknown collection "' + token.collectionId + '"', { collectionId: token.collectionId });
  }
  if (!catalog.userExists(sellerId)) {
    throw inputError('unknown_user', 'unknown user "' + sellerId + '"', { userId: sellerId });
  }
  return { tokenId, sellerId, price };
}

export function parseCancelParams(orderId: string, body: unknown): CancelParams {
  const obj = requireObject(body);
  return { orderId, actorId: requireString(obj, 'actorId') };
}

export function parseAcceptParams(orderId: string, body: unknown, catalog: CatalogView): AcceptParams {
  const obj = requireObject(body);
  const buyerId = requireString(obj, 'buyerId');
  if (!catalog.userExists(buyerId)) {
    throw inputError('unknown_user', 'unknown user "' + buyerId + '"', { userId: buyerId });
  }
  return { orderId, buyerId };
}
