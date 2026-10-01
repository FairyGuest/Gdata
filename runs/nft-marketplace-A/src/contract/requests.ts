/**
 * Request contract parsing for list / cancel / accept.
 *
 * Shape and domain validation (422) happens here, against the read-only
 * AssetDirectory port. State/policy decisions (409) stay in the kernel.
 */

import { ErrorReason, MarketError } from '../errors.js';
import {
  AcceptOrderInput,
  AssetDirectory,
  CancelOrderInput,
  CreateListingInput,
} from './types.js';
import { parsePositiveInteger, requireNonEmptyString } from './primitives.js';

export function parseCreateListing(
  raw: unknown,
  directory: AssetDirectory,
): CreateListingInput {
  const body = asObject(raw, 'listing request');
  const collectionId = requireNonEmptyString(body.collectionId, 'collectionId');
  const tokenId = requireNonEmptyString(body.tokenId, 'tokenId');
  const sellerId = requireNonEmptyString(body.sellerId, 'sellerId');
  const price = parsePositiveInteger(body.price, 'price');

  const collection = directory.findCollection(collectionId);
  if (!collection) {
    throw new MarketError(
      'input',
      ErrorReason.UnknownCollection,
      `Unknown collection '${collectionId}'`,
      { collectionId },
    );
  }
  const token = directory.findToken(collectionId, tokenId);
  if (!token) {
    throw new MarketError(
      'input',
      ErrorReason.UnknownToken,
      `Token '${tokenId}' does not exist in collection '${collectionId}'`,
      { collectionId, tokenId },
    );
  }
  if (!directory.findUser(sellerId)) {
    throw new MarketError(
      'input',
      ErrorReason.UnknownUser,
      `Unknown seller '${sellerId}'`,
      { sellerId },
    );
  }
  return { collectionId, tokenId, sellerId, price };
}

export function parseCancelOrder(
  raw: unknown,
  directory: AssetDirectory,
): CancelOrderInput {
  const body = asObject(raw, 'cancel request');
  const orderId = requireNonEmptyString(body.orderId, 'orderId');
  const requesterId = requireNonEmptyString(body.requesterId, 'requesterId');
  if (!directory.findUser(requesterId)) {
    throw new MarketError(
      'input',
      ErrorReason.UnknownUser,
      `Unknown requester '${requesterId}'`,
      { requesterId },
    );
  }
  if (!directory.findOrder(orderId)) {
    throw new MarketError(
      'input',
      ErrorReason.UnknownOrder,
      `Unknown order '${orderId}'`,
      { orderId },
    );
  }
  return { orderId, requesterId };
}

export function parseAcceptOrder(
  raw: unknown,
  directory: AssetDirectory,
): AcceptOrderInput {
  const body = asObject(raw, 'accept request');
  const orderId = requireNonEmptyString(body.orderId, 'orderId');
  const buyerId = requireNonEmptyString(body.buyerId, 'buyerId');
  if (!directory.findUser(buyerId)) {
    throw new MarketError(
      'input',
      ErrorReason.UnknownUser,
      `Unknown buyer '${buyerId}'`,
      { buyerId },
    );
  }
  if (!directory.findOrder(orderId)) {
    throw new MarketError(
      'input',
      ErrorReason.UnknownOrder,
      `Unknown order '${orderId}'`,
      { orderId },
    );
  }
  return { orderId, buyerId };
}

function asObject(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new MarketError(
      'input',
      ErrorReason.BadType,
      `${label} body must be a JSON object`,
      { received: typeof raw },
    );
  }
  return raw as Record<string, unknown>;
}
