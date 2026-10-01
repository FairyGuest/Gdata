import type { DatabaseSync } from "node:sqlite";
import {
  computeError,
  conflictError,
  inputError,
} from "../contract/errors.js";
import type {
  AcceptBidInput,
  CancelBidInput,
  CreateBidInput,
  RoyaltyRecipient,
} from "../contract/models.js";
import { splitPayment } from "../contract/arithmetic.js";
import {
  assertSellerOwnsToken,
  validateAccept,
  validateCancel,
  validateCreate,
  type LedgerReadPort,
} from "../contract/validator.js";
import { assertDeltasConserve, assertSplitsEqualPrice, type BalanceDelta } from "./invariants.js";
import type {
  AcceptBidResult,
  CancelBidResult,
  CreateBidResult,
  OperationOptions,
  RoyaltyUpdateResult,
} from "./types.js";
import type { SqliteEngine, TransactionHooks } from "../state/sqlite-engine.js";
import { ledgerRepo } from "../state/ledger-repo.js";
import type { DiagLogger } from "../diag/logger.js";

export interface MatcherDeps {
  readonly engine: SqliteEngine;
  readonly logger: DiagLogger;
  readonly newRunId: () => string;
  readonly newBidId: () => string;
}

interface Preflight {
  readonly runId: string;
  readonly hooks?: TransactionHooks;
}

const resolveOptions = (options: OperationOptions | undefined, deps: MatcherDeps): Preflight => ({
  runId: options?.runId ?? deps.newRunId(),
  hooks: options?.hooks,
});

function balancesOf(db: DatabaseSync, userIds: ReadonlySet<string>) {
  return [...userIds].map((userId) => {
    const account = ledgerRepo.findAccount(db, userId);
    if (!account) throw computeError("invariant_violation", "account vanished during transaction", { userId });
    return { userId, available: account.availableBalance, frozen: account.frozenBalance };
  });
}

function readPort(db: DatabaseSync): LedgerReadPort {
  return {
    findCollection: (collectionId) => ledgerRepo.findCollection(db, collectionId),
    findToken: (tokenId) => ledgerRepo.findToken(db, tokenId),
    findBid: (bidId) => ledgerRepo.findBid(db, bidId),
    findAccount: (userId) => ledgerRepo.findAccount(db, userId),
  };
}

function raceLost(current: { status: string; filledCommitSeq: number | null; cancelledCommitSeq: number | null }) {
  const winningCommitSeq = current.filledCommitSeq ?? current.cancelledCommitSeq;
  return conflictError("commit_race_lost", "bid changed state in a concurrently committed transaction", {
    currentStatus: current.status,
    winningCommitSeq,
    arbitration: "sqlite_commit_log_seq",
  });
}

export class Matcher {
  private readonly engine: SqliteEngine;
  private readonly logger: DiagLogger;
  private readonly newRunId: () => string;
  private readonly newBidId: () => string;

  constructor(deps: MatcherDeps) {
    this.engine = deps.engine;
    this.logger = deps.logger;
    this.newRunId = deps.newRunId;
    this.newBidId = deps.newBidId;
  }

  async createBid(input: CreateBidInput, options?: OperationOptions): Promise<CreateBidResult> {
    const { runId, hooks } = resolveOptions(options, { engine: this.engine, logger: this.logger, newRunId: this.newRunId, newBidId: this.newBidId });
    try {
      const result = await this.engine.writeTx((db) => {
        const { collection } = validateCreate(readPort(db), input);
        const bidder = ledgerRepo.findAccount(db, input.bidderId)!;
        if (!ledgerRepo.freezeBalance(db, input.bidderId, input.amount)) {
          throw conflictError("insufficient_balance", "available balance is lower than the bid amount", {
            bidderId: input.bidderId,
            availableBalance: bidder.availableBalance,
            requestedFreeze: input.amount,
          });
        }
        const bidId = this.newBidId();
        const seq = ledgerRepo.appendCommit(db, {
          runId,
          op: "create_bid",
          bidId,
          statusFrom: null,
          statusTo: "active",
          detail: {
            bidderId: input.bidderId,
            collectionId: input.collectionId,
            amount: input.amount,
            snapshotRoyaltyBps: collection.royaltyBps,
            snapshotVersion: collection.version,
          },
        });
        ledgerRepo.insertBid(db, {
          bidId,
          collectionId: input.collectionId,
          bidderId: input.bidderId,
          amount: input.amount,
          royaltyBpsSnapshot: collection.royaltyBps,
          recipientsSnapshot: collection.recipients,
          createdCommitSeq: seq,
        });
        const deltas: readonly BalanceDelta[] = [
          { userId: input.bidderId, deltaAvailable: -input.amount, deltaFrozen: input.amount, kind: "freeze" },
        ];
        assertDeltasConserve(deltas, { runId, bidId, op: "create_bid" });
        ledgerRepo.insertMovement(db, { ...deltas[0]!, commitSeq: seq, runId, bidId });
        const refreshed = ledgerRepo.findAccount(db, input.bidderId)!;
        const bid = ledgerRepo.findBid(db, bidId)!;
        return {
          outcome: "created" as const,
          runId,
          commitSeq: seq,
          bid,
          frozenAmount: input.amount,
          bidderBalances: { available: refreshed.availableBalance, frozen: refreshed.frozenBalance },
          decisionBasis: `commit seq ${seq} froze ${input.amount} and snapshotted collection "${input.collectionId}" royalty bps ${collection.royaltyBps} at version ${collection.version}`,
        };
      }, hooks);
      this.logger.record({
        ts: new Date().toISOString(), runId, commitSeq: result.commitSeq, op: "create_bid",
        bidId: result.bid.bidId, statusFrom: null, statusTo: "active", outcome: "accepted", httpStatus: 201,
        reason: null, decisionBasis: result.decisionBasis, amount: result.frozenAmount,
        sellerAmount: null, royaltyAmount: null, splits: [], snapshot: {
          royaltyBps: result.bid.royaltyBpsSnapshot, recipients: result.bid.recipientsSnapshot,
        }, message: null,
      });
      return result;
    } catch (error) {
      recordRejection(this.logger, runId, "create_bid", null, error, input.amount);
      throw error;
    }
  }

  async cancelBid(input: CancelBidInput, options?: OperationOptions): Promise<CancelBidResult> {
    const { runId, hooks } = resolveOptions(options, { engine: this.engine, logger: this.logger, newRunId: this.newRunId, newBidId: this.newBidId });
    let preflightActive = false;
    try {
      await this.engine.read((db) => {
        const { bid } = validateCancel(readPort(db), input);
        if (bid.bidderId !== input.requesterId) {
          throw conflictError("not_bid_owner", "only the bid creator may cancel the bid", {
            bidId: input.bidId, requesterId: input.requesterId, ownerId: bid.bidderId,
          });
        }
        if (bid.status === "filled") {
          throw conflictError("bid_already_filled", "a filled bid cannot be cancelled", { bidId: input.bidId, filledCommitSeq: bid.filledCommitSeq });
        }
        if (bid.status === "cancelled") {
          throw conflictError("bid_already_cancelled", "a cancelled bid cannot be cancelled again", { bidId: input.bidId });
        }
        preflightActive = bid.status === "active";
      });
      const result = await this.engine.writeTx((db) => {
        const bid = ledgerRepo.findBid(db, input.bidId)!;
        if (bid.status !== "active") {
          if (preflightActive) throw raceLost(bid);
          throw bid.status === "filled"
            ? conflictError("bid_already_filled", "a filled bid cannot be cancelled", { bidId: bid.bidId })
            : conflictError("bid_already_cancelled", "a cancelled bid cannot be cancelled again", { bidId: bid.bidId });
        }
        if (!ledgerRepo.unfreezeBalance(db, bid.bidderId, bid.amount)) {
          throw computeError("invariant_violation", "frozen balance could not cover bid release", {
            bidId: bid.bidId, bidderId: bid.bidderId, amount: bid.amount,
          });
        }
        const seq = ledgerRepo.appendCommit(db, {
          runId, op: "cancel_bid", bidId: bid.bidId, statusFrom: "active", statusTo: "cancelled",
          detail: { requesterId: input.requesterId, unfrozenAmount: bid.amount, createdCommitSeq: bid.createdCommitSeq },
        });
        ledgerRepo.markBidCancelled(db, bid.bidId, seq);
        const deltas: readonly BalanceDelta[] = [
          { userId: bid.bidderId, deltaAvailable: bid.amount, deltaFrozen: -bid.amount, kind: "unfreeze" },
        ];
        assertDeltasConserve(deltas, { runId, bidId: bid.bidId, op: "cancel_bid" });
        ledgerRepo.insertMovement(db, { ...deltas[0]!, commitSeq: seq, runId, bidId: bid.bidId });
        const refreshed = ledgerRepo.findAccount(db, bid.bidderId)!;
        return {
          outcome: "cancelled" as const, runId, commitSeq: seq, bidId: bid.bidId, unfrozenAmount: bid.amount,
          bidderBalances: { available: refreshed.availableBalance, frozen: refreshed.frozenBalance },
          decisionBasis: `commit seq ${seq} is the sole serialization point; ${bid.amount} moved from frozen back to available`,
        };
      }, hooks);
      this.logger.record({
        ts: new Date().toISOString(), runId, commitSeq: result.commitSeq, op: "cancel_bid",
        bidId: result.bidId, statusFrom: "active", statusTo: "cancelled", outcome: "accepted", httpStatus: 200,
        reason: null, decisionBasis: result.decisionBasis, amount: result.unfrozenAmount,
        sellerAmount: null, royaltyAmount: null, splits: [], snapshot: null, message: null,
      });
      return result;
    } catch (error) {
      recordRejection(this.logger, runId, "cancel_bid", input.bidId, error, null);
      throw error;
    }
  }

  async acceptBid(input: AcceptBidInput, options?: OperationOptions): Promise<AcceptBidResult> {
    const { runId, hooks } = resolveOptions(options, { engine: this.engine, logger: this.logger, newRunId: this.newRunId, newBidId: this.newBidId });
    let preflightActive = false;
    try {
      await this.engine.read((db) => {
        const { bid, token } = validateAccept(readPort(db), input);
        if (bid.status === "filled") {
          throw conflictError("bid_already_filled", "bid was already filled", { bidId: bid.bidId, filledCommitSeq: bid.filledCommitSeq });
        }
        if (bid.status === "cancelled") {
          throw conflictError("bid_already_cancelled", "bid was already cancelled", { bidId: bid.bidId, cancelledCommitSeq: bid.cancelledCommitSeq });
        }
        preflightActive = true;
        assertSellerOwnsToken(token, input.sellerId);
      });
      const result = await this.engine.writeTx((db) => {
        const bid = ledgerRepo.findBid(db, input.bidId)!;
        if (bid.status !== "active") {
          if (preflightActive) throw raceLost(bid);
          throw bid.status === "filled"
            ? conflictError("bid_already_filled", "bid was already filled", { bidId: bid.bidId })
            : conflictError("bid_already_cancelled", "bid was already cancelled", { bidId: bid.bidId });
        }
        const token = ledgerRepo.findToken(db, input.tokenId)!;
        if (token.collectionId !== bid.collectionId) {
          throw inputError("token_not_in_collection", "token does not belong to the bid collection", { tokenId: input.tokenId });
        }
        assertSellerOwnsToken(token, input.sellerId);
        const price = bid.amount;
        const split = splitPayment(price, bid.royaltyBpsSnapshot, bid.recipientsSnapshot);
        const affectedUserIds = new Set<string>([bid.bidderId, input.sellerId, ...split.recipientPayments.map((payment) => payment.userId)]);
        if (!ledgerRepo.debitFrozen(db, bid.bidderId, price)) {
          throw computeError("invariant_violation", "buyer frozen balance could not cover the accepted bid", {
            bidId: bid.bidId, bidderId: bid.bidderId, price,
          });
        }
        ledgerRepo.creditAvailable(db, input.sellerId, split.sellerAmount);
        for (const payment of split.recipientPayments) {
          if (payment.amount > 0) ledgerRepo.creditAvailable(db, payment.userId, payment.amount);
        }
        if (!ledgerRepo.transferToken(db, token.tokenId, bid.bidderId)) {
          throw computeError("invariant_violation", "token transfer affected zero rows", { tokenId: token.tokenId });
        }
        const seq = ledgerRepo.appendCommit(db, {
          runId, op: "accept_bid", bidId: bid.bidId, statusFrom: "active", statusTo: "filled",
          detail: {
            sellerId: input.sellerId, tokenId: token.tokenId, newOwnerId: bid.bidderId, price,
            royaltyBpsSnapshot: bid.royaltyBpsSnapshot, sellerAmount: split.sellerAmount, royaltyAmount: split.royaltyAmount,
            splits: split.recipientPayments, arbitration: "sqlite_commit_log_seq",
          },
        });
        const filled = ledgerRepo.markBidFilled(db, {
          bidId: bid.bidId, commitSeq: seq, tokenId: token.tokenId, sellerId: input.sellerId,
          sellerAmount: split.sellerAmount, royaltyAmount: split.royaltyAmount,
        });
        if (!filled) throw raceLost(bid);
        for (const payment of split.recipientPayments) {
          ledgerRepo.insertRoyaltyPayment(db, { commitSeq: seq, bidId: bid.bidId, payeeUserId: payment.userId, amount: payment.amount });
        }
        const deltas: BalanceDelta[] = [
          { userId: bid.bidderId, deltaAvailable: 0, deltaFrozen: -price, kind: "frozen_debit" },
          { userId: input.sellerId, deltaAvailable: split.sellerAmount, deltaFrozen: 0, kind: "seller_credit" },
          ...split.recipientPayments.map((payment) => ({
            userId: payment.userId, deltaAvailable: payment.amount, deltaFrozen: 0, kind: "royalty_credit",
          })),
        ];
        assertDeltasConserve(deltas, { runId, bidId: bid.bidId, op: "accept_bid" });
        assertSplitsEqualPrice({
          price, sellerAmount: split.sellerAmount, royaltyAmount: split.royaltyAmount,
          splitAmounts: split.recipientPayments.map((payment) => payment.amount),
          context: { runId, bidId: bid.bidId },
        });
        for (const delta of deltas) {
          ledgerRepo.insertMovement(db, { ...delta, commitSeq: seq, runId, bidId: bid.bidId });
        }
        const postBalances = balancesOf(db, affectedUserIds);
        return {
          outcome: "filled" as const, runId, commitSeq: seq, bidId: bid.bidId, collectionId: bid.collectionId,
          tokenId: token.tokenId, sellerId: input.sellerId, newOwnerId: bid.bidderId, price,
          sellerAmount: split.sellerAmount, royaltyAmount: split.royaltyAmount,
          royaltyBpsSnapshot: bid.royaltyBpsSnapshot,
          splits: split.recipientPayments,
          postBalances,
          decisionBasis: `serialized at commit seq ${seq}; buyer paid exactly ${price} from frozen funds; royalty floor(${price} * ${bid.royaltyBpsSnapshot} / 10000) = ${split.royaltyAmount} from the bid-creation snapshot`,
        };
      }, hooks);
      this.logger.record({
        ts: new Date().toISOString(), runId, commitSeq: result.commitSeq, op: "accept_bid",
        bidId: result.bidId, statusFrom: "active", statusTo: "filled", outcome: "accepted", httpStatus: 200,
        reason: null, decisionBasis: result.decisionBasis, amount: result.price,
        sellerAmount: result.sellerAmount, royaltyAmount: result.royaltyAmount,
        splits: result.splits.map((split) => ({ payeeUserId: split.userId, amount: split.amount })),
        snapshot: { newOwnerId: result.newOwnerId, tokenId: result.tokenId, royaltyBps: result.royaltyBpsSnapshot, commitSeq: result.commitSeq },
        message: null,
      });
      return result;
    } catch (error) {
      recordRejection(this.logger, runId, "accept_bid", input.bidId, error, null);
      throw error;
    }
  }
  async updateRoyalty(
    input: { readonly collectionId: string; readonly royaltyBps: number; readonly recipients: readonly RoyaltyRecipient[] },
    options?: OperationOptions,
  ): Promise<RoyaltyUpdateResult> {
    const { runId, hooks } = resolveOptions(options, { engine: this.engine, logger: this.logger, newRunId: this.newRunId, newBidId: this.newBidId });
    try {
      const result = await this.engine.writeTx((db) => {
        const collection = ledgerRepo.findCollection(db, input.collectionId);
        if (!collection) throw inputError("unknown_collection", "collection does not exist", { collectionId: input.collectionId });
        const seq = ledgerRepo.appendCommit(db, {
          runId, op: "update_royalty", bidId: null, statusFrom: null, statusTo: null,
          detail: {
            collectionId: input.collectionId, previousBps: collection.royaltyBps, nextBps: input.royaltyBps,
            previousVersion: collection.version, recipients: input.recipients,
          },
        });
        ledgerRepo.setCollectionRoyalty(db, input.collectionId, input.royaltyBps, input.recipients, seq);
        const refreshed = ledgerRepo.findCollection(db, input.collectionId)!;
        return {
          outcome: "royalty_updated" as const, runId, commitSeq: seq, collectionId: input.collectionId,
          royaltyBps: refreshed.royaltyBps, version: refreshed.version,
        };
      }, hooks);
      this.logger.record({
        ts: new Date().toISOString(), runId, commitSeq: result.commitSeq, op: "update_royalty",
        bidId: null, statusFrom: null, statusTo: null, outcome: "accepted", httpStatus: 200,
        reason: null,
        decisionBasis: `commit seq ${result.commitSeq} updated current config only; existing bids retain their creation snapshot`,
        amount: null, sellerAmount: null, royaltyAmount: null, splits: [],
        snapshot: { royaltyBps: result.royaltyBps, version: result.version }, message: null,
      });
      return result;
    } catch (error) {
      recordRejection(this.logger, runId, "update_royalty", null, error, null);
      throw error;
    }
  }
}

function isRecordedError(value: unknown): value is { statusCode: number; reason: string; message: string; category: string; details?: Record<string, unknown> } {
  return typeof value === "object" && value !== null && "reason" in value && "statusCode" in value;
}

function recordErrorBody(logger: DiagLogger, fields: {
  runId: string; op: string; bidId: string | null; amount: number | null; error: unknown;
}): void {
  const { runId, op, bidId, amount, error } = fields;
  if (isRecordedError(error)) {
    (error as { runId?: string }).runId = runId;
    const outcome = error.statusCode >= 500 ? "error" : "rejected";
    logger.record({
      ts: new Date().toISOString(), runId, commitSeq: null, op, bidId,
      statusFrom: null, statusTo: null, outcome, httpStatus: error.statusCode, reason: error.reason,
      decisionBasis: `classified as ${error.category}/${error.reason}; no bid state transition committed`,
      amount, sellerAmount: null, royaltyAmount: null, splits: [],
      snapshot: error.details ? error.details : null, message: error.message,
    });
    return;
  }
  logger.record({
    ts: new Date().toISOString(), runId, commitSeq: null, op, bidId,
    statusFrom: null, statusTo: null, outcome: "error", httpStatus: 500, reason: "unexpected_error",
    decisionBasis: "unknown error type; surfaced as compute failure without committing ledger changes",
    amount, sellerAmount: null, royaltyAmount: null, splits: [], snapshot: null,
    message: error instanceof Error ? error.message : String(error),
  });
}

function recordRejection(
  logger: DiagLogger,
  runId: string,
  op: string,
  bidId: string | null,
  error: unknown,
  amount: number | null,
): void {
  recordErrorBody(logger, { runId, op, bidId, amount, error });
}

