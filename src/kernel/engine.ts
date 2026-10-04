import { MarketError, inputError, internalError, policyError, stateError } from '../contract/errors.ts';
import type { AcceptParams, CancelParams, ListParams } from '../contract/parse.ts';
import type { Journal } from '../diag/journal.ts';
import type { Ledger, OrderRecord } from '../state/ledger.ts';

export interface Split {
  royalty: number;
  sellerProceeds: number;
}

export interface FillResult {
  orderId: string;
  tokenId: string;
  collectionId: string;
  buyerId: string;
  sellerId: string;
  price: number;
  royalty: number;
  sellerProceeds: number;
  royaltyRecipient: string;
  newOwner: string;
  commitSeq: number;
  runId: string;
}

/** Pure split rule: royalty = floor(price * bps / 10000), seller gets the rest. */
export function computeSplit(price: number, bps: number): Split {
  const royalty = Math.floor((price * bps) / 10000);
  return { royalty, sellerProceeds: price - royalty };
}

function assertConservation(price: number, split: Split): void {
  const deltasSum = -price + split.sellerProceeds + split.royalty;
  if (split.royalty < 0 || split.sellerProceeds < 0 || split.royalty + split.sellerProceeds !== price || deltasSum !== 0) {
    throw internalError('conservation_violation', 'split does not conserve value', {
      price,
      royalty: split.royalty,
      sellerProceeds: split.sellerProceeds,
      deltasSum,
    });
  }
}

/**
 * Execution kernel. Every state-changing operation runs inside one SQLite
 * transaction (BEGIN IMMEDIATE): ownership transfer, buyer debit, royalty and
 * seller credits, order status and the commit sequence all commit or roll
 * back together. Concurrent accepts are therefore arbitrated by commit order,
 * never by request arrival time.
 */
export class MarketEngine {
  private readonly ledger: Ledger;
  private readonly journal: Journal;

  constructor(ledger: Ledger, journal: Journal) {
    this.ledger = ledger;
    this.journal = journal;
  }

  list(params: ListParams, requestId: string): OrderRecord {
    try {
      return this.ledger.tx(() => {
        const token = this.ledger.getToken(params.tokenId);
        if (!token) throw inputError('unknown_token', 'unknown token "' + params.tokenId + '"', { tokenId: params.tokenId });
        const collection = this.ledger.getCollection(token.collectionId);
        if (!collection) {
          throw inputError('unknown_collection', 'unknown collection "' + token.collectionId + '"', { collectionId: token.collectionId });
        }
        if (collection.soulbound) {
          throw policyError('soulbound_transfer', 'collection "' + collection.id + '" is soulbound: listings are forbidden', {
            collectionId: collection.id,
            tokenId: token.id,
          });
        }
        const existing = this.ledger.getOpenOrderForToken(token.id);
        if (existing) {
          throw stateError('duplicate_listing', 'token "' + token.id + '" already has open order "' + existing.id + '"', {
            tokenId: token.id,
            existingOrderId: existing.id,
          });
        }
        if (token.ownerId !== params.sellerId) {
          throw stateError('seller_not_owner', 'user "' + params.sellerId + '" does not hold token "' + token.id + '"', {
            tokenId: token.id,
            ownerId: token.ownerId,
          });
        }
        const seq = this.ledger.nextSeq('order_seq');
        const order: OrderRecord = {
          id: 'ord-' + String(seq),
          tokenId: token.id,
          collectionId: collection.id,
          sellerId: params.sellerId,
          price: params.price,
          // Snapshot the split configuration at listing time; later collection
          // edits must not affect this order.
          royaltyBps: collection.royaltyBps,
          royaltyRecipient: collection.royaltyRecipient,
          status: 'open',
          buyerId: null,
          createdSeq: seq,
          commitSeq: null,
        };
        this.ledger.insertOrder(order);
        this.journal.record({
          requestId,
          orderId: order.id,
          transition: 'none->open',
          detail: JSON.stringify({ price: order.price, royaltyBps: order.royaltyBps, royaltyRecipient: order.royaltyRecipient }),
        });
        return order;
      });
    } catch (err) {
      this.recordRejection(requestId, null, 'list', err);
      throw err;
    }
  }

  cancel(params: CancelParams, requestId: string): OrderRecord {
    try {
      return this.ledger.tx(() => {
        const order = this.ledger.getOrder(params.orderId);
        if (!order) throw inputError('unknown_order', 'unknown order "' + params.orderId + '"', { orderId: params.orderId });
        if (order.status !== 'open') {
          throw stateError('order_not_open', 'order "' + order.id + '" is ' + order.status + ' and cannot be cancelled', {
            orderId: order.id,
            status: order.status,
          });
        }
        if (order.sellerId !== params.actorId) {
          throw stateError('not_order_creator', 'user "' + params.actorId + '" did not create order "' + order.id + '"', {
            orderId: order.id,
            sellerId: order.sellerId,
          });
        }
        this.ledger.setOrderCancelled(order.id);
        this.journal.record({ requestId, orderId: order.id, transition: 'open->cancelled', reason: 'cancelled_by_creator' });
        return { ...order, status: 'cancelled' as const };
      });
    } catch (err) {
      this.recordRejection(requestId, params.orderId, 'cancel', err);
      throw err;
    }
  }

  accept(params: AcceptParams, requestId: string): FillResult {
    let outcome: { kind: 'filled'; fill: FillResult } | { kind: 'lapsed'; order: OrderRecord; ownerId: string };
    try {
      outcome = this.ledger.tx(() => {
        const order = this.ledger.getOrder(params.orderId);
        if (!order) throw inputError('unknown_order', 'unknown order "' + params.orderId + '"', { orderId: params.orderId });
        if (order.status !== 'open') {
          throw stateError('order_not_open', 'order "' + order.id + '" is ' + order.status, {
            orderId: order.id,
            status: order.status,
            commitSeq: order.commitSeq,
          });
        }
        const collection = this.ledger.getCollection(order.collectionId);
        if (!collection) {
          throw inputError('unknown_collection', 'unknown collection "' + order.collectionId + '"', { collectionId: order.collectionId });
        }
        if (collection.soulbound) {
          throw policyError('soulbound_transfer', 'collection "' + collection.id + '" is soulbound: transfers are forbidden', {
            collectionId: collection.id,
            tokenId: order.tokenId,
            orderId: order.id,
          });
        }
        const token = this.ledger.getToken(order.tokenId);
        if (!token) throw inputError('unknown_token', 'unknown token "' + order.tokenId + '"', { tokenId: order.tokenId });
        if (token.ownerId !== order.sellerId) {
          // Stale listing: the seller no longer holds the token. Lapse the
          // order inside this transaction, then report the conflict.
          this.ledger.setOrderCancelled(order.id);
          this.journal.record({
            requestId,
            orderId: order.id,
            transition: 'open->cancelled',
            reason: 'seller_not_owner',
            detail: JSON.stringify({ ownerId: token.ownerId, sellerId: order.sellerId }),
          });
          return { kind: 'lapsed' as const, order, ownerId: token.ownerId };
        }
        const buyerBalance = this.ledger.getBalance(params.buyerId);
        if (buyerBalance === undefined) {
          throw inputError('unknown_user', 'unknown user "' + params.buyerId + '"', { userId: params.buyerId });
        }
        if (buyerBalance < order.price) {
          throw stateError('insufficient_balance', 'buyer "' + params.buyerId + '" cannot cover price ' + String(order.price), {
            buyerId: params.buyerId,
            balance: buyerBalance,
            price: order.price,
          });
        }

        // Split uses the snapshot taken at listing time.
        const split = computeSplit(order.price, order.royaltyBps);
        assertConservation(order.price, split);

        const commitSeq = this.ledger.nextSeq('commit_seq');
        this.ledger.debit(params.buyerId, order.price);
        this.ledger.credit(order.sellerId, split.sellerProceeds);
        if (split.royalty > 0) {
          this.ledger.credit(order.royaltyRecipient, split.royalty);
        }
        this.ledger.transferToken(order.tokenId, params.buyerId);
        this.ledger.setOrderFilled(order.id, params.buyerId, commitSeq);

        const fill: FillResult = {
          orderId: order.id,
          tokenId: order.tokenId,
          collectionId: order.collectionId,
          buyerId: params.buyerId,
          sellerId: order.sellerId,
          price: order.price,
          royalty: split.royalty,
          sellerProceeds: split.sellerProceeds,
          royaltyRecipient: order.royaltyRecipient,
          newOwner: params.buyerId,
          commitSeq,
          runId: this.journal.runId,
        };
        this.ledger.insertFill({
          orderId: fill.orderId,
          buyerId: fill.buyerId,
          sellerId: fill.sellerId,
          price: fill.price,
          royalty: fill.royalty,
          sellerProceeds: fill.sellerProceeds,
          royaltyRecipient: fill.royaltyRecipient,
          commitSeq: fill.commitSeq,
          runId: fill.runId,
        });
        this.journal.record({
          requestId,
          orderId: order.id,
          transition: 'open->filled',
          detail: JSON.stringify({
            buyerId: fill.buyerId,
            price: fill.price,
            royalty: fill.royalty,
            sellerProceeds: fill.sellerProceeds,
            commitSeq: fill.commitSeq,
          }),
        });

        // Ledger-wide conservation: total balances must equal the seeded sum.
        const expected = Number(this.ledger.getMeta('expected_balance_sum'));
        const actual = this.ledger.sumBalances();
        if (actual !== expected) {
          throw internalError('conservation_violation', 'ledger balance sum drifted after fill', {
            expected,
            actual,
            orderId: order.id,
          });
        }
        return { kind: 'filled' as const, fill };
      });
    } catch (err) {
      this.recordRejection(requestId, params.orderId, 'accept', err);
      throw err;
    }
    if (outcome.kind === 'lapsed') {
      const err = stateError('seller_not_owner', 'seller no longer holds the token; order "' + outcome.order.id + '" lapsed', {
        orderId: outcome.order.id,
        sellerId: outcome.order.sellerId,
        ownerId: outcome.ownerId,
      });
      this.recordRejection(requestId, outcome.order.id, 'accept', err);
      throw err;
    }
    return outcome.fill;
  }

  private recordRejection(requestId: string, orderId: string | null, op: string, err: unknown): void {
    if (!(err instanceof MarketError)) return;
    try {
      this.journal.record({
        requestId,
        orderId,
        transition: op + '_rejected',
        reason: err.category + ':' + err.reason,
        detail: JSON.stringify({ message: err.message, ...(err.details ?? {}) }),
      });
    } catch {
      // diag must never mask the original error
    }
  }
}
