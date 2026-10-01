import type { DatabaseSync, StatementSync } from "node:sqlite";
import type {
  AccountRow,
  BidRow,
  CollectionRow,
  RoyaltyRecipient,
  TokenRow,
} from "../contract/models.js";
import type { FixtureData } from "./fixtures.js";

export interface BidInsert {
  readonly bidId: string;
  readonly collectionId: string;
  readonly bidderId: string;
  readonly amount: number;
  readonly royaltyBpsSnapshot: number;
  readonly recipientsSnapshot: readonly RoyaltyRecipient[];
  readonly createdCommitSeq: number;
}

export interface CommitEntry {
  readonly runId: string;
  readonly op: string;
  readonly bidId: string | null;
  readonly statusFrom: string | null;
  readonly statusTo: string | null;
  readonly detail: Record<string, unknown>;
}

export interface BalanceMovementRow {
  readonly commitSeq: number;
  readonly runId: string;
  readonly bidId: string | null;
  readonly userId: string;
  readonly deltaAvailable: number;
  readonly deltaFrozen: number;
  readonly kind: string;
}

export interface CommitRow {
  readonly seq: number;
  readonly runId: string;
  readonly op: string;
  readonly bidId: string | null;
  readonly statusFrom: string | null;
  readonly statusTo: string | null;
  readonly detail: Record<string, unknown>;
}

const statementCache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

function stmt(db: DatabaseSync, sql: string): StatementSync {
  let cache = statementCache.get(db);
  if (!cache) {
    cache = new Map<string, StatementSync>();
    statementCache.set(db, cache);
  }
  let prepared = cache.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    cache.set(sql, prepared);
  }
  return prepared;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

const integer = (value: unknown): number => Number(value);

function mapCollection(row: unknown): CollectionRow | null {
  const record = asRecord(row);
  if (!record) return null;
  return {
    collectionId: String(record.collection_id),
    royaltyBps: integer(record.royalty_bps),
    recipients: JSON.parse(String(record.recipients_json)) as RoyaltyRecipient[],
    version: integer(record.version),
  };
}

function mapToken(row: unknown): TokenRow | null {
  const record = asRecord(row);
  if (!record) return null;
  return {
    tokenId: String(record.token_id),
    collectionId: String(record.collection_id),
    ownerId: String(record.owner_id),
  };
}

function mapAccount(row: unknown): AccountRow | null {
  const record = asRecord(row);
  if (!record) return null;
  return {
    userId: String(record.user_id),
    availableBalance: integer(record.available_balance),
    frozenBalance: integer(record.frozen_balance),
  };
}

function mapBid(row: unknown): BidRow | null {
  const record = asRecord(row);
  if (!record) return null;
  return {
    bidId: String(record.bid_id),
    collectionId: String(record.collection_id),
    bidderId: String(record.bidder_id),
    amount: integer(record.amount),
    status: String(record.status) as BidRow["status"],
    royaltyBpsSnapshot: integer(record.royalty_bps_snapshot),
    recipientsSnapshot: JSON.parse(String(record.recipients_snapshot_json)) as RoyaltyRecipient[],
    createdCommitSeq: integer(record.created_commit_seq),
    filledCommitSeq: record.filled_commit_seq === null ? null : integer(record.filled_commit_seq),
    cancelledCommitSeq: record.cancelled_commit_seq === null ? null : integer(record.cancelled_commit_seq),
    fillTokenId: record.fill_token_id === null ? null : String(record.fill_token_id),
    fillSellerId: record.fill_seller_id === null ? null : String(record.fill_seller_id),
    sellerAmount: record.seller_amount === null ? null : integer(record.seller_amount),
    royaltyAmount: record.royalty_amount === null ? null : integer(record.royalty_amount),
  };
}


export const ledgerRepo = Object.freeze({
  isSeeded(db: DatabaseSync): boolean {
    const row = stmt(db, "SELECT COUNT(*) AS c FROM users").get() as { c: number };
    return Number(row.c) > 0;
  },

  seed(db: DatabaseSync, fixtures: FixtureData): void {
    const insertUser = stmt(
      db,
      "INSERT INTO users(user_id, available_balance, frozen_balance) VALUES (?, ?, ?)",
    );
    for (const user of fixtures.users) {
      insertUser.run(user.userId, user.availableBalance, user.frozenBalance);
    }
    const insertCollection = stmt(
      db,
      "INSERT INTO collections(collection_id, royalty_bps, recipients_json, version, updated_seq) VALUES (?, ?, ?, ?, NULL)",
    );
    for (const collection of fixtures.collections) {
      insertCollection.run(
        collection.collectionId,
        collection.royaltyBps,
        JSON.stringify(collection.recipients),
        collection.version,
      );
    }
    const insertToken = stmt(db, "INSERT INTO tokens(token_id, collection_id, owner_id) VALUES (?, ?, ?)");
    for (const token of fixtures.tokens) {
      insertToken.run(token.tokenId, token.collectionId, token.ownerId);
    }
  },

  findCollection(db: DatabaseSync, collectionId: string): CollectionRow | null {
    return mapCollection(
      stmt(
        db,
        "SELECT collection_id, royalty_bps, recipients_json, version FROM collections WHERE collection_id = ?",
      ).get(collectionId),
    );
  },

  setCollectionRoyalty(
    db: DatabaseSync,
    collectionId: string,
    royaltyBps: number,
    recipients: readonly RoyaltyRecipient[],
    updatedSeq: number,
  ): void {
    stmt(
      db,
      "UPDATE collections SET royalty_bps = ?, recipients_json = ?, version = version + 1, updated_seq = ? WHERE collection_id = ?",
    ).run(royaltyBps, JSON.stringify(recipients), updatedSeq, collectionId);
  },

  findToken(db: DatabaseSync, tokenId: string): TokenRow | null {
    return mapToken(
      stmt(db, "SELECT token_id, collection_id, owner_id FROM tokens WHERE token_id = ?").get(tokenId),
    );
  },

  findAccount(db: DatabaseSync, userId: string): AccountRow | null {
    return mapAccount(
      stmt(db, "SELECT user_id, available_balance, frozen_balance FROM users WHERE user_id = ?").get(userId),
    );
  },

  listAccounts(db: DatabaseSync): AccountRow[] {
    const rows = stmt(
      db,
      "SELECT user_id, available_balance, frozen_balance FROM users ORDER BY user_id",
    ).all() as unknown[];
    return rows.map(mapAccount).filter((row): row is AccountRow => row !== null);
  },

  insertBid(db: DatabaseSync, bid: BidInsert): void {
    stmt(
      db,
      "INSERT INTO bids(bid_id, collection_id, bidder_id, amount, status, royalty_bps_snapshot, recipients_snapshot_json, created_commit_seq) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)",
    ).run(
      bid.bidId,
      bid.collectionId,
      bid.bidderId,
      bid.amount,
      bid.royaltyBpsSnapshot,
      JSON.stringify(bid.recipientsSnapshot),
      bid.createdCommitSeq,
    );
  },

  findBid(db: DatabaseSync, bidId: string): BidRow | null {
    return mapBid(stmt(db, "SELECT * FROM bids WHERE bid_id = ?").get(bidId));
  },

  listBidsByCollection(db: DatabaseSync, collectionId: string): BidRow[] {
    const rows = stmt(
      db,
      "SELECT * FROM bids WHERE collection_id = ? ORDER BY created_commit_seq",
    ).all(collectionId) as unknown[];
    return rows.map(mapBid).filter((row): row is BidRow => row !== null);
  },

  listBids(db: DatabaseSync): BidRow[] {
    const rows = stmt(db, "SELECT * FROM bids ORDER BY created_commit_seq").all() as unknown[];
    return rows.map(mapBid).filter((row): row is BidRow => row !== null);
  },

  freezeBalance(db: DatabaseSync, userId: string, amount: number): boolean {
    const result = stmt(
      db,
      "UPDATE users SET available_balance = available_balance - ?, frozen_balance = frozen_balance + ? WHERE user_id = ? AND available_balance >= ?",
    ).run(amount, amount, userId, amount);
    return Number(result.changes) === 1;
  },

  unfreezeBalance(db: DatabaseSync, userId: string, amount: number): boolean {
    const result = stmt(
      db,
      "UPDATE users SET available_balance = available_balance + ?, frozen_balance = frozen_balance - ? WHERE user_id = ? AND frozen_balance >= ?",
    ).run(amount, amount, userId, amount);
    return Number(result.changes) === 1;
  },

  debitFrozen(db: DatabaseSync, userId: string, amount: number): boolean {
    const result = stmt(
      db,
      "UPDATE users SET frozen_balance = frozen_balance - ? WHERE user_id = ? AND frozen_balance >= ?",
    ).run(amount, userId, amount);
    return Number(result.changes) === 1;
  },

  creditAvailable(db: DatabaseSync, userId: string, amount: number): void {
    stmt(db, "UPDATE users SET available_balance = available_balance + ? WHERE user_id = ?").run(
      amount,
      userId,
    );
  },

  transferToken(db: DatabaseSync, tokenId: string, newOwnerId: string): boolean {
    const result = stmt(db, "UPDATE tokens SET owner_id = ? WHERE token_id = ?").run(
      newOwnerId,
      tokenId,
    );
    return Number(result.changes) === 1;
  },

  markBidFilled(
    db: DatabaseSync,
    params: {
      readonly bidId: string;
      readonly commitSeq: number;
      readonly tokenId: string;
      readonly sellerId: string;
      readonly sellerAmount: number;
      readonly royaltyAmount: number;
    },
  ): boolean {
    const result = stmt(
      db,
      `UPDATE bids SET status = 'filled', filled_commit_seq = ?, fill_token_id = ?, fill_seller_id = ?,
         seller_amount = ?, royalty_amount = ? WHERE bid_id = ? AND status = 'active'`,
    ).run(
      params.commitSeq,
      params.tokenId,
      params.sellerId,
      params.sellerAmount,
      params.royaltyAmount,
      params.bidId,
    );
    return Number(result.changes) === 1;
  },

  markBidCancelled(db: DatabaseSync, bidId: string, commitSeq: number): boolean {
    const result = stmt(
      db,
      "UPDATE bids SET status = 'cancelled', cancelled_commit_seq = ? WHERE bid_id = ? AND status = 'active'",
    ).run(commitSeq, bidId);
    return Number(result.changes) === 1;
  },

  appendCommit(db: DatabaseSync, entry: CommitEntry): number {
    const result = stmt(
      db,
      "INSERT INTO commit_log(run_id, op, bid_id, status_from, status_to, detail_json) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      entry.runId,
      entry.op,
      entry.bidId,
      entry.statusFrom,
      entry.statusTo,
      JSON.stringify(entry.detail),
    );
    return Number(result.lastInsertRowid);
  },

  insertRoyaltyPayment(
    db: DatabaseSync,
    params: { readonly commitSeq: number; readonly bidId: string; readonly payeeUserId: string; readonly amount: number },
  ): void {
    stmt(db, "INSERT INTO royalty_payments(commit_seq, bid_id, payee_user_id, amount) VALUES (?, ?, ?, ?)").run(
      params.commitSeq,
      params.bidId,
      params.payeeUserId,
      params.amount,
    );
  },

  listRoyaltyPayments(db: DatabaseSync, bidId: string): Array<{ readonly commitSeq: number; readonly payeeUserId: string; readonly amount: number }> {
    const rows = stmt(
      db,
      "SELECT commit_seq AS commitSeq, payee_user_id AS payeeUserId, amount FROM royalty_payments WHERE bid_id = ? ORDER BY payment_id",
    ).all(bidId) as unknown[];
    return rows.map((row) => {
      const record = asRecord(row)!;
      return {
        commitSeq: integer(record.commitSeq),
        payeeUserId: String(record.payeeUserId),
        amount: integer(record.amount),
      };
    });
  },

  insertMovement(
    db: DatabaseSync,
    movement: BalanceMovementRow,
  ): void {
    stmt(
      db,
      `INSERT INTO balance_movements(commit_seq, run_id, bid_id, user_id, delta_available, delta_frozen, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      movement.commitSeq,
      movement.runId,
      movement.bidId,
      movement.userId,
      movement.deltaAvailable,
      movement.deltaFrozen,
      movement.kind,
    );
  },

  listMovements(db: DatabaseSync): BalanceMovementRow[] {
    const rows = stmt(
      db,
      "SELECT commit_seq AS commitSeq, run_id AS runId, bid_id AS bidId, user_id AS userId, delta_available AS deltaAvailable, delta_frozen AS deltaFrozen, kind FROM balance_movements ORDER BY movement_id",
    ).all() as unknown[];
    return rows.map((row) => {
      const record = asRecord(row)!;
      return {
        commitSeq: integer(record.commitSeq),
        runId: String(record.runId),
        bidId: record.bidId === null ? null : String(record.bidId),
        userId: String(record.userId),
        deltaAvailable: integer(record.deltaAvailable),
        deltaFrozen: integer(record.deltaFrozen),
        kind: String(record.kind),
      };
    });
  },

  listCommits(db: DatabaseSync, bidId: string): CommitRow[] {
    const rows = stmt(
      db,
      "SELECT seq, run_id AS runId, op, bid_id AS bidId, status_from AS statusFrom, status_to AS statusTo, detail_json AS detailJson FROM commit_log WHERE bid_id = ? ORDER BY seq",
    ).all(bidId) as unknown[];
    return rows.map((row) => {
      const record = asRecord(row)!;
      return {
        seq: integer(record.seq),
        runId: String(record.runId),
        op: String(record.op),
        bidId: record.bidId === null ? null : String(record.bidId),
        statusFrom: record.statusFrom === null ? null : String(record.statusFrom),
        statusTo: record.statusTo === null ? null : String(record.statusTo),
        detail: JSON.parse(String(record.detailJson)) as Record<string, unknown>,
      };
    });
  },

  listAllCommits(db: DatabaseSync, limit = 200): CommitRow[] {
    const rows = stmt(
      db,
      "SELECT seq, run_id AS runId, op, bid_id AS bidId, status_from AS statusFrom, status_to AS statusTo, detail_json AS detailJson FROM commit_log ORDER BY seq DESC LIMIT ?",
    ).all(limit) as unknown[];
    return rows
      .map((row) => {
        const record = asRecord(row)!;
        return {
          seq: integer(record.seq),
          runId: String(record.runId),
          op: String(record.op),
          bidId: record.bidId === null ? null : String(record.bidId),
          statusFrom: record.statusFrom === null ? null : String(record.statusFrom),
          statusTo: record.statusTo === null ? null : String(record.statusTo),
          detail: JSON.parse(String(record.detailJson)) as Record<string, unknown>,
        };
      })
      .reverse();
  },

  ledgerTotals(db: DatabaseSync): { available: number; frozen: number } {
    const row = stmt(
      db,
      "SELECT COALESCE(SUM(available_balance), 0) AS available, COALESCE(SUM(frozen_balance), 0) AS frozen FROM users",
    ).get() as { available: number; frozen: number };
    return { available: integer(row.available), frozen: integer(row.frozen) };
  }
});
