import { ConflictError, ConservationError, isAppError } from "../errors.js";
import type { Ledger, BidRow, BidStatus } from "../state/db.js";
import type { DiagLog } from "../diag/index.js";
import type {
  CreateBidCommand,
  CancelBidCommand,
  AcceptBidCommand,
} from "../contract/index.js";

export interface KernelHooks {
  /**
   * Test-only interleaving point between contract validation and the commit
   * transaction. Lets concurrency tests force a specific commit ordering
   * without relying on wall-clock timing.
   */
  beforeCommit?: (op: "create" | "cancel" | "accept", bidId: string | null) => Promise<void>;
}

export interface FillResult {
  bidId: string;
  collectionId: string;
  tokenId: string;
  sellerId: string;
  newOwnerId: string;
  price: number;
  royaltyBps: number;
  royalty: number;
  sellerProceeds: number;
  royaltyRecipient: string;
  commitSeq: number;
}

/**
 * Matching kernel. Every mutation is a single immediate SQLite transaction
 * that (a) freezes/moves balances, (b) flips bid state via a conditional
 * UPDATE guarded on status='open', (c) asserts ledger conservation, and
 * (d) stamps the monotonic commit sequence that arbitrates races. There is
 * no "flip state first, patch balances later" path: a failed assertion
 * rolls the whole transaction back.
 */
export class BidEngine {
  constructor(
    private readonly ledger: Ledger,
    private readonly diag: DiagLog,
    private readonly hooks: KernelHooks = {},
  ) {}

  private assertConservation(before: number, op: string, bidId: string): void {
    const after = this.ledger.totalBalances();
    if (after !== before) {
      throw new ConservationError(
        "conservation_violation",
        "ledger conservation check failed during " + op,
        { op, bidId, totalBefore: before, totalAfter: after },
      );
    }
  }

  private conflictForClosedBid(
    op: string,
    observed: BidRow,
    current: BidRow,
  ): ConflictError {
    const sawOpen = observed.status === "open";
    const reason = sawOpen
      ? "race_lost"
      : current.status === "filled"
        ? "bid_already_filled"
        : "bid_already_cancelled";
    return new ConflictError(reason, op + " lost: bid is " + current.status, {
      bidId: current.id,
      currentStatus: current.status,
      winningCommitSeq: current.stateSeq,
      observedStatusAtValidation: observed.status,
    });
  }

  async createBid(cmd: CreateBidCommand): Promise<BidRow> {
    if (this.hooks.beforeCommit) await this.hooks.beforeCommit("create", null);
    try {
      return this.ledger.runTx((seq) => {
        const collection = this.ledger.getCollection(cmd.collectionId);
        if (!collection) {
          throw new ConservationError("snapshot_missing", "collection vanished mid-transaction", {
            collectionId: cmd.collectionId,
          });
        }
        const account = this.ledger.getAccount(cmd.bidderId);
        if (!account) {
          throw new ConflictError("unknown_bidder", "bidder account does not exist", {
            bidderId: cmd.bidderId,
          });
        }
        if (account.available < cmd.price) {
          throw new ConflictError("insufficient_balance", "available balance below bid price", {
            bidderId: cmd.bidderId,
            available: account.available,
            price: cmd.price,
          });
        }
        const before = this.ledger.totalBalances();
        const bidId = "bid-" + seq;
        this.ledger.db
          .prepare("UPDATE accounts SET available = available - ?, frozen = frozen + ? WHERE user_id = ?")
          .run(cmd.price, cmd.price, cmd.bidderId);
        this.ledger.db
          .prepare(
            "INSERT INTO bids (id, collection_id, bidder_id, price, royalty_bps, royalty_recipient, status, created_seq, state_seq) " +
              "VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)",
          )
          .run(
            bidId,
            cmd.collectionId,
            cmd.bidderId,
            cmd.price,
            collection.royaltyBps,
            collection.royaltyRecipient,
            seq,
            seq,
          );
        this.assertConservation(before, "create", bidId);
        this.diag.record({
          commitSeq: seq,
          bidId,
          eventType: "bid_created",
          fromStatus: null,
          toStatus: "open",
          reason: null,
          detail: {
            collectionId: cmd.collectionId,
            bidderId: cmd.bidderId,
            price: cmd.price,
            royaltyBpsSnapshot: collection.royaltyBps,
            royaltyRecipientSnapshot: collection.royaltyRecipient,
            frozen: cmd.price,
          },
        });
        const bid = this.ledger.getBid(bidId);
        if (!bid) throw new ConservationError("snapshot_missing", "bid insert not visible", { bidId });
        return bid;
      });
    } catch (err) {
      if (isAppError(err)) {
        this.diag.recordSafe({
          commitSeq: null,
          bidId: null,
          eventType: "create_rejected",
          fromStatus: null,
          toStatus: null,
          reason: err.reason,
          detail: { bidderId: cmd.bidderId, collectionId: cmd.collectionId, price: cmd.price },
        });
      }
      throw err;
    }
  }

  async cancelBid(cmd: CancelBidCommand): Promise<BidRow> {
    if (this.hooks.beforeCommit) await this.hooks.beforeCommit("cancel", cmd.bidId);
    try {
      return this.ledger.runTx((seq) => {
        const bid = this.ledger.getBid(cmd.bidId);
        if (!bid) {
          throw new ConservationError("snapshot_missing", "bid vanished mid-transaction", {
            bidId: cmd.bidId,
          });
        }
        if (bid.bidderId !== cmd.actorId) {
          throw new ConflictError("not_bid_creator", "only the bid creator can cancel", {
            bidId: bid.id,
            actorId: cmd.actorId,
            bidderId: bid.bidderId,
          });
        }
        const changed = this.ledger.db
          .prepare("UPDATE bids SET status = 'cancelled', state_seq = ? WHERE id = ? AND status = 'open'")
          .run(seq, bid.id).changes;
        if (changed !== 1) {
          const current = this.ledger.getBid(cmd.bidId);
          throw this.conflictForClosedBid("cancel", cmd.observed, current ?? bid);
        }
        const before = this.ledger.totalBalances();
        this.ledger.db
          .prepare("UPDATE accounts SET available = available + ?, frozen = frozen - ? WHERE user_id = ?")
          .run(bid.price, bid.price, bid.bidderId);
        this.assertConservation(before, "cancel", bid.id);
        this.diag.record({
          commitSeq: seq,
          bidId: bid.id,
          eventType: "bid_cancelled",
          fromStatus: "open",
          toStatus: "cancelled",
          reason: null,
          detail: { actorId: cmd.actorId, unfrozen: bid.price },
        });
        const updated = this.ledger.getBid(bid.id);
        if (!updated) throw new ConservationError("snapshot_missing", "bid vanished", { bidId: bid.id });
        return updated;
      });
    } catch (err) {
      if (isAppError(err)) {
        this.diag.recordSafe({
          commitSeq: null,
          bidId: cmd.bidId,
          eventType: "cancel_rejected",
          fromStatus: cmd.observed.status,
          toStatus: null,
          reason: err.reason,
          detail: { actorId: cmd.actorId },
        });
      }
      throw err;
    }
  }

  async acceptBid(cmd: AcceptBidCommand): Promise<FillResult> {
    if (this.hooks.beforeCommit) await this.hooks.beforeCommit("accept", cmd.bidId);
    try {
      return this.ledger.runTx((seq) => {
        const bid = this.ledger.getBid(cmd.bidId);
        if (!bid) {
          throw new ConservationError("snapshot_missing", "bid vanished mid-transaction", {
            bidId: cmd.bidId,
          });
        }
        if (bid.status !== "open") {
          throw this.conflictForClosedBid("accept", cmd.observed, bid);
        }
        const token = this.ledger.getToken(cmd.tokenId);
        if (!token || token.collectionId !== bid.collectionId) {
          throw new ConservationError("snapshot_missing", "token inconsistent with bid collection", {
            tokenId: cmd.tokenId,
            bidId: bid.id,
          });
        }
        if (token.ownerId !== cmd.sellerId) {
          throw new ConflictError("seller_not_token_owner", "seller does not hold this token", {
            tokenId: cmd.tokenId,
            sellerId: cmd.sellerId,
            currentOwnerId: token.ownerId,
          });
        }
        // Royalty split from the snapshot taken at bid creation.
        const royalty = Math.floor((bid.price * bid.royaltyBps) / 10000);
        const sellerProceeds = bid.price - royalty;
        if (royalty < 0 || sellerProceeds < 0 || royalty + sellerProceeds !== bid.price) {
          throw new ConservationError("split_mismatch", "royalty split does not sum to price", {
            price: bid.price,
            royalty,
            sellerProceeds,
          });
        }
        const changed = this.ledger.db
          .prepare(
            "UPDATE bids SET status = 'filled', state_seq = ?, fill_token_id = ?, fill_seller_id = ? " +
              "WHERE id = ? AND status = 'open'",
          )
          .run(seq, cmd.tokenId, cmd.sellerId, bid.id).changes;
        if (changed !== 1) {
          const current = this.ledger.getBid(cmd.bidId);
          throw this.conflictForClosedBid("accept", cmd.observed, current ?? bid);
        }
        const before = this.ledger.totalBalances();
        const deducted = this.ledger.db
          .prepare("UPDATE accounts SET frozen = frozen - ? WHERE user_id = ? AND frozen >= ?")
          .run(bid.price, bid.bidderId, bid.price).changes;
        if (deducted !== 1) {
          throw new ConservationError("conservation_violation", "buyer frozen balance went negative", {
            bidId: bid.id,
          });
        }
        this.ledger.db
          .prepare("INSERT INTO accounts (user_id, available, frozen) VALUES (?, 0, 0) ON CONFLICT(user_id) DO NOTHING")
          .run(cmd.sellerId);
        this.ledger.db
          .prepare("UPDATE accounts SET available = available + ? WHERE user_id = ?")
          .run(sellerProceeds, cmd.sellerId);
        this.ledger.db
          .prepare("INSERT INTO accounts (user_id, available, frozen) VALUES (?, 0, 0) ON CONFLICT(user_id) DO NOTHING")
          .run(bid.royaltyRecipient);
        this.ledger.db
          .prepare("UPDATE accounts SET available = available + ? WHERE user_id = ?")
          .run(royalty, bid.royaltyRecipient);
        this.ledger.db
          .prepare("UPDATE tokens SET owner_id = ? WHERE id = ?")
          .run(bid.bidderId, cmd.tokenId);
        this.assertConservation(before, "accept", bid.id);
        const result: FillResult = {
          bidId: bid.id,
          collectionId: bid.collectionId,
          tokenId: cmd.tokenId,
          sellerId: cmd.sellerId,
          newOwnerId: bid.bidderId,
          price: bid.price,
          royaltyBps: bid.royaltyBps,
          royalty,
          sellerProceeds,
          royaltyRecipient: bid.royaltyRecipient,
          commitSeq: seq,
        };
        this.diag.record({
          commitSeq: seq,
          bidId: bid.id,
          eventType: "bid_filled",
          fromStatus: "open",
          toStatus: "filled",
          reason: null,
          detail: {
            tokenId: cmd.tokenId,
            sellerId: cmd.sellerId,
            newOwnerId: bid.bidderId,
            price: bid.price,
            royaltyBps: bid.royaltyBps,
            royalty,
            sellerProceeds,
            royaltyRecipient: bid.royaltyRecipient,
          },
        });
        return result;
      });
    } catch (err) {
      if (isAppError(err)) {
        this.diag.recordSafe({
          commitSeq: null,
          bidId: cmd.bidId,
          eventType: "accept_rejected",
          fromStatus: cmd.observed.status,
          toStatus: null,
          reason: err.reason,
          detail: { sellerId: cmd.sellerId, tokenId: cmd.tokenId },
        });
      }
      throw err;
    }
  }
}
