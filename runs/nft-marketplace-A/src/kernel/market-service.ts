import {
  AcceptOrderInput,
  CancelOrderInput,
  CreateListingInput,
  OrderRecord,
  RoyaltySplit,
  TokenRecord,
} from '../contract/types.js';
import { ErrorReason, MarketError } from '../errors.js';
import { SqliteLedger } from '../state/sqlite-ledger.js';
import { SettlementResult } from '../state/ports.js';
import { computeRoyaltySplit } from './royalty.js';
import { assertLedgerConservation, assertRoyaltyConservation } from './invariants.js';

export interface OperationContext {
  runId: string;
}

export interface ListingResult {
  kind: 'listing_created';
  runId: string;
  commitSeq: number;
  order: OrderRecord;
  token: TokenRecord;
  collectionVersion: number;
  snapshot: {
    royaltyBps: number;
    royaltyRecipient: string;
    soulbound: boolean;
  };
  transition: { from: 'none'; to: 'active' };
  basis: string;
}

export interface CancellationResult {
  kind: 'order_cancelled';
  runId: string;
  commitSeq: number;
  order: OrderRecord;
  transition: { from: 'active'; to: 'cancelled' };
  basis: string;
}

export interface AcceptResult {
  kind: 'order_filled';
  runId: string;
  commitSeq: number;
  order: OrderRecord;
  token: TokenRecord;
  price: number;
  buyer: string;
  seller: string;
  newOwner: string;
  split: RoyaltySplit;
  royaltyRecipient: string;
  affectedBalances: Record<string, { before: number; after: number; delta: number }>;
  settlement: SettlementResult;
  transition: { from: 'active'; to: 'filled' };
  basis: string;
}

export class MarketService {
  constructor(private readonly ledger: SqliteLedger) {}

  async createListing(input: CreateListingInput, context: OperationContext): Promise<ListingResult> {
    return this.ledger.withTransaction<ListingResult>({
      runId: context.runId,
      kind: 'listing_create',
      refId: input.collectionId + '/' + input.tokenId,
      initialDetail: { request: input },
      work: (tx) => {
        const collection = tx.getCollection(input.collectionId);
        const token = tx.getToken(input.collectionId, input.tokenId);
        if (!collection || !token) {
          throw new MarketError(
            'input',
            !collection ? ErrorReason.UnknownCollection : ErrorReason.UnknownToken,
            'Asset disappeared inside the listing transaction',
            { collectionId: input.collectionId, tokenId: input.tokenId },
          );
        }

        if (collection.soulbound) {
          throw new MarketError(
            'policy',
            ErrorReason.SoulboundListing,
            'Soulbound tokens cannot be listed for trade',
            { collectionId: collection.id, tokenId: token.id },
            {
              action: 'list',
              tokenId: token.id,
              transition: null,
              basis: 'server policy: collections.soulbound=1 forbids listing',
            },
          );
        }

        if (token.owner !== input.sellerId) {
          throw new MarketError(
            'state',
            ErrorReason.SellerNotHolder,
            'Only the current token owner can list it',
            {
              collectionId: input.collectionId,
              tokenId: input.tokenId,
              expectedHolder: token.owner,
              sellerId: input.sellerId,
            },
          );
        }

        const activeOrder = tx.findActiveOrder(input.collectionId, input.tokenId);
        if (activeOrder) {
          throw new MarketError(
            'state',
            ErrorReason.DuplicateListing,
            'Token already has an active fixed-price order',
            {
              collectionId: input.collectionId,
              tokenId: input.tokenId,
              existingOrderId: activeOrder.id,
            },
            {
              action: 'list',
              orderId: activeOrder.id,
              tokenId: input.tokenId,
              transition: null,
              basis: 'active order exists for exactly this collection_id/token_id',
            },
          );
        }

        const snapshot = {
          royaltyBps: collection.royaltyBps,
          royaltyRecipient: collection.royaltyRecipient,
          soulbound: collection.soulbound,
        };
        const order = tx.insertListing({
          collectionId: input.collectionId,
          tokenId: input.tokenId,
          seller: input.sellerId,
          price: input.price,
          royaltyBpsSnapshot: snapshot.royaltyBps,
          royaltyRecipientSnapshot: snapshot.royaltyRecipient,
          soulboundSnapshot: snapshot.soulbound,
        });
        tx.appendCommitDetail({
          orderId: order.id,
          transition: { from: 'none', to: 'active' },
          snapshot,
          basis: 'collection snapshot copied into order at listing commit',
        });

        return {
          kind: 'listing_created',
          runId: context.runId,
          commitSeq: tx.commitSeq,
          order,
          token,
          collectionVersion: collection.version,
          snapshot,
          transition: { from: 'none', to: 'active' },
          basis: 'collection snapshot copied into order at listing commit',
        };
      },
    });
  }
  async cancelOrder(input: CancelOrderInput, context: OperationContext): Promise<CancellationResult> {
    return this.ledger.withTransaction<CancellationResult>({
      runId: context.runId,
      kind: 'order_cancel',
      refId: input.orderId,
      initialDetail: { request: input },
      work: (tx) => {
        const order = tx.getOrder(input.orderId);
        if (!order) {
          throw new MarketError(
            'input',
            ErrorReason.UnknownOrder,
            'Unknown order',
            { orderId: input.orderId },
          );
        }
        if (order.status === 'filled') {
          throw new MarketError(
            'state',
            ErrorReason.OrderAlreadyFilled,
            'Filled order cannot be cancelled',
            { orderId: order.id, filledCommitSeq: order.filledCommitSeq },
            {
              action: 'cancel',
              orderId: order.id,
              transition: null,
              commitSeq: order.filledCommitSeq,
              basis: 'order status=filled; cancellation state machine permits active only',
            },
          );
        }
        if (order.status === 'cancelled') {
          throw new MarketError(
            'state',
            ErrorReason.OrderAlreadyCancelled,
            'Cancelled order cannot be cancelled again',
            { orderId: order.id, cancelledCommitSeq: order.cancelledCommitSeq },
            {
              action: 'cancel',
              orderId: order.id,
              transition: null,
              commitSeq: order.cancelledCommitSeq,
              basis: 'order status=cancelled; cancellation state machine permits active only',
            },
          );
        }
        if (order.seller !== input.requesterId) {
          throw new MarketError(
            'state',
            ErrorReason.NotOrderCreator,
            'Only the order creator can cancel the listing',
            { orderId: order.id, creator: order.seller, requester: input.requesterId },
            {
              action: 'cancel',
              orderId: order.id,
              transition: null,
              basis: 'requester_id differs from order.seller',
            },
          );
        }

        tx.cancelOrder(order);
        tx.appendCommitDetail({
          orderId: order.id,
          transition: { from: 'active', to: 'cancelled' },
          basis: 'active order and requester equals creator',
        });
        return {
          kind: 'order_cancelled',
          runId: context.runId,
          commitSeq: tx.commitSeq,
          order: tx.getOrder(order.id)!,
          transition: { from: 'active', to: 'cancelled' },
          basis: 'active order and requester equals creator',
        };
      },
    });
  }

  async acceptOrder(input: AcceptOrderInput, context: OperationContext): Promise<AcceptResult> {
    return this.ledger.withTransaction<AcceptResult>({
      runId: context.runId,
      kind: 'order_accept',
      refId: input.orderId,
      initialDetail: { request: input },
      work: (tx) => {
        const order = tx.getOrder(input.orderId);
        if (!order) {
          throw new MarketError(
            'input',
            ErrorReason.UnknownOrder,
            'Unknown order',
            { orderId: input.orderId },
          );
        }
        const currentCollection = tx.getCollection(order.collectionId);
        if (currentCollection?.soulbound || order.soulboundSnapshot) {
          throw new MarketError(
            'policy',
            ErrorReason.SoulboundAccept,
            'Soulbound tokens cannot be traded',
            {
              orderId: order.id,
              collectionId: order.collectionId,
              tokenId: order.tokenId,
            },
            {
              action: 'accept',
              orderId: order.id,
              tokenId: order.tokenId,
              transition: null,
              basis: 'server policy: current collection soulbound=true or order snapshot soulbound=true forbids accept',
            },
          );
        }
        if (order.status === 'filled') {
          throw new MarketError(
            'state',
            ErrorReason.OrderAlreadyFilled,
            'Order has already been filled',
            { orderId: order.id, filledCommitSeq: order.filledCommitSeq },
            {
              action: 'accept',
              orderId: order.id,
              transition: null,
              commitSeq: order.filledCommitSeq,
              basis: 'order status=filled; commit sequence already transferred the token',
            },
          );
        }
        if (order.status === 'cancelled') {
          throw new MarketError(
            'state',
            ErrorReason.OrderAlreadyCancelled,
            'Cancelled order cannot be accepted',
            { orderId: order.id, cancelledCommitSeq: order.cancelledCommitSeq },
            {
              action: 'accept',
              orderId: order.id,
              transition: null,
              commitSeq: order.cancelledCommitSeq,
              basis: 'order status=cancelled',
            },
          );
        }

        const token = tx.getToken(order.collectionId, order.tokenId);
        if (!token) {
          throw new MarketError(
            'input',
            ErrorReason.UnknownToken,
            'Listed token no longer exists',
            { collectionId: order.collectionId, tokenId: order.tokenId },
          );
        }
        if (token.owner !== order.seller) {
          throw new MarketError(
            'state',
            ErrorReason.SellerNotHolder,
            'Listing is invalid because seller no longer holds the token',
            {
              orderId: order.id,
              collectionId: order.collectionId,
              tokenId: order.tokenId,
              expectedHolder: order.seller,
              currentHolder: token.owner,
            },
            {
              action: 'accept',
              orderId: order.id,
              tokenId: order.tokenId,
              transition: null,
              basis: 'tokens.owner must equal order.seller at accept commit',
            },
          );
        }
        if (input.buyerId === order.seller) {
          throw new MarketError(
            'state',
            ErrorReason.SellerNotHolder,
            'Buyer cannot be the order seller',
            { orderId: order.id, buyerId: input.buyerId, seller: order.seller },
            {
              action: 'accept',
              orderId: order.id,
              tokenId: order.tokenId,
              transition: null,
              basis: 'buyer_id must differ from order.seller',
            },
          );
        }

        const buyerBefore = tx.getUser(input.buyerId);
        if (!buyerBefore) {
          throw new MarketError(
            'input',
            ErrorReason.UnknownUser,
            'Unknown buyer',
            { buyerId: input.buyerId },
          );
        }
        if (buyerBefore.balance < order.price) {
          throw new MarketError(
            'state',
            ErrorReason.InsufficientBalance,
            'Buyer balance is below fixed listing price',
            {
              orderId: order.id,
              buyer: input.buyerId,
              balance: buyerBefore.balance,
              required: order.price,
            },
            {
              action: 'accept',
              orderId: order.id,
              tokenId: order.tokenId,
              transition: null,
              basis: 'buyer balance read in accept transaction is below order.price',
            },
          );
        }

        const split = computeRoyaltySplit(order.price, order.royaltyBpsSnapshot);
        assertRoyaltyConservation(split);
        const sellerBefore = tx.getUser(order.seller);
        const recipientBefore = tx.getUser(order.royaltyRecipientSnapshot);
        if (!sellerBefore || !recipientBefore) {
          throw new MarketError(
            'computation',
            ErrorReason.Unexpected,
            'Settlement references a missing account',
            {
              seller: order.seller,
              royaltyRecipient: order.royaltyRecipientSnapshot,
            },
          );
        }

        const usersBefore = [buyerBefore, sellerBefore, recipientBefore]
          .filter((user, index, all) => all.findIndex((candidate) => candidate.id === user.id) === index);
        const settlement = tx.settleOrder({
          order,
          buyer: input.buyerId,
          nextOwner: input.buyerId,
          royaltyRecipient: order.royaltyRecipientSnapshot,
          royaltyAmount: split.royaltyAmount,
          sellerProceeds: split.sellerProceeds,
          detail: {
            request: input,
            split,
            snapshot: {
              royaltyBps: order.royaltyBpsSnapshot,
              royaltyRecipient: order.royaltyRecipientSnapshot,
              soulbound: order.soulboundSnapshot,
            },
          },
        });

        const usersAfter = settlement.affectedUsers;
        assertLedgerConservation({
          totalBalanceBefore: settlement.totalBalanceBefore,
          totalBalanceAfter: settlement.totalBalanceAfter,
          tokenCountBefore: settlement.tokenCountBefore,
          tokenCountAfter: settlement.tokenCountAfter,
          usersBefore,
          usersAfter,
        });

        const beforeById = new Map(usersBefore.map((user) => [user.id, user.balance]));
        const affectedBalances: AcceptResult['affectedBalances'] = {};
        for (const user of usersAfter) {
          const before = beforeById.get(user.id) ?? 0;
          affectedBalances[user.id] = {
            before,
            after: user.balance,
            delta: user.balance - before,
          };
        }

        const filledOrder = settlement.order;
        tx.appendCommitDetail({
          runId: context.runId,
          orderId: filledOrder.id,
          transition: { from: 'active', to: 'filled' },
          split,
          basis:
            'won internal commit sequence ' +
            tx.commitSeq +
            '; active conditional order/token updates both changed one row',
        });

        return {
          kind: 'order_filled',
          runId: context.runId,
          commitSeq: tx.commitSeq,
          order: filledOrder,
          token: settlement.token,
          price: order.price,
          buyer: input.buyerId,
          seller: order.seller,
          newOwner: settlement.token.owner,
          split,
          royaltyRecipient: order.royaltyRecipientSnapshot,
          affectedBalances,
          settlement,
          transition: { from: 'active', to: 'filled' },
          basis:
            'won internal commit sequence ' +
            tx.commitSeq +
            '; ownership, debit, royalty and seller credit committed together',
        };
      },
    });
  }
}