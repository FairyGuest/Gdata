import { DatabaseSync } from "node:sqlite";
import { ResourceError, isAppError } from "../errors.js";

export interface CollectionRow {
  id: string;
  name: string;
  royaltyBps: number;
  royaltyRecipient: string;
}

export interface TokenRow {
  id: string;
  collectionId: string;
  ownerId: string;
}

export interface AccountRow {
  userId: string;
  available: number;
  frozen: number;
}

export type BidStatus = "open" | "cancelled" | "filled";

export interface BidRow {
  id: string;
  collectionId: string;
  bidderId: string;
  price: number;
  royaltyBps: number;
  royaltyRecipient: string;
  status: BidStatus;
  createdSeq: number;
  stateSeq: number;
  fillTokenId: string | null;
  fillSellerId: string | null;
}

export interface DiagEventRow {
  id: number;
  runId: string;
  commitSeq: number | null;
  bidId: string | null;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  detail: Record<string, unknown> | null;
}

const SCHEMA: string[] = [
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS collections (" +
    "id TEXT PRIMARY KEY, " +
    "name TEXT NOT NULL, " +
    "royalty_bps INTEGER NOT NULL, " +
    "royalty_recipient TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS tokens (" +
    "id TEXT PRIMARY KEY, " +
    "collection_id TEXT NOT NULL REFERENCES collections(id), " +
    "owner_id TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS accounts (" +
    "user_id TEXT PRIMARY KEY, " +
    "available INTEGER NOT NULL, " +
    "frozen INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS bids (" +
    "id TEXT PRIMARY KEY, " +
    "collection_id TEXT NOT NULL REFERENCES collections(id), " +
    "bidder_id TEXT NOT NULL, " +
    "price INTEGER NOT NULL, " +
    "royalty_bps INTEGER NOT NULL, " +
    "royalty_recipient TEXT NOT NULL, " +
    "status TEXT NOT NULL, " +
    "created_seq INTEGER NOT NULL, " +
    "state_seq INTEGER NOT NULL, " +
    "fill_token_id TEXT, " +
    "fill_seller_id TEXT)",
  "CREATE TABLE IF NOT EXISTS diag_events (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
    "run_id TEXT NOT NULL, " +
    "commit_seq INTEGER, " +
    "bid_id TEXT, " +
    "event_type TEXT NOT NULL, " +
    "from_status TEXT, " +
    "to_status TEXT, " +
    "reason TEXT, " +
    "detail TEXT)",
];

interface RawBid {
  id: string;
  collection_id: string;
  bidder_id: string;
  price: number;
  royalty_bps: number;
  royalty_recipient: string;
  status: string;
  created_seq: number;
  state_seq: number;
  fill_token_id: string | null;
  fill_seller_id: string | null;
}

function toBid(row: RawBid): BidRow {
  return {
    id: row.id,
    collectionId: row.collection_id,
    bidderId: row.bidder_id,
    price: row.price,
    royaltyBps: row.royalty_bps,
    royaltyRecipient: row.royalty_recipient,
    status: row.status as BidStatus,
    createdSeq: row.created_seq,
    stateSeq: row.state_seq,
    fillTokenId: row.fill_token_id,
    fillSellerId: row.fill_seller_id,
  };
}

/**
 * SQLite ledger: token ownership, available/frozen balances, the bid book,
 * per-bid royalty snapshots and the monotonic commit sequence used to
 * arbitrate concurrent mutations. All mutating kernel operations run inside
 * a single immediate transaction through runTx().
 */
export class Ledger {
  readonly db: DatabaseSync;

  constructor(path: string) {
    try {
      this.db = new DatabaseSync(path);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA busy_timeout = 2000");
      this.db.exec("PRAGMA foreign_keys = ON");
    } catch (err) {
      throw new ResourceError("storage_unavailable", "cannot open SQLite storage", {
        path,
        cause: String(err),
      });
    }
    this.migrate();
  }

  private migrate(): void {
    this.exec(() => {
      for (const stmt of SCHEMA) this.db.exec(stmt);
      this.db
        .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('commit_seq', '0')")
        .run();
    }, "storage_unavailable");
  }

  close(): void {
    this.db.close();
  }

  /** Translate low-level SQLite failures into the resource-exhaustion category. */
  private exec<T>(fn: () => T, reason: string): T {
    try {
      return fn();
    } catch (err) {
      if (isAppError(err)) throw err;
      const text = String(err);
      if (text.includes("SQLITE_BUSY") || text.includes("database is locked")) {
        throw new ResourceError("lock_wait_timeout", "SQLite lock wait timed out", {
          cause: text,
        });
      }
      throw new ResourceError(reason, "SQLite storage failure", { cause: text });
    }
  }

  /** Run fn inside an immediate transaction; assigns the next commit sequence. */
  runTx<T>(fn: (commitSeq: number) => T): T {
    return this.exec(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'commit_seq'")
          .run();
        const row = this.db
          .prepare("SELECT CAST(value AS INTEGER) AS seq FROM meta WHERE key = 'commit_seq'")
          .get() as { seq: number };
        const result = fn(row.seq);
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // already rolled back
        }
        throw err;
      }
    }, "storage_unavailable");
  }

  currentCommitSeq(): number {
    const row = this.db
      .prepare("SELECT CAST(value AS INTEGER) AS seq FROM meta WHERE key = 'commit_seq'")
      .get() as { seq: number };
    return row.seq;
  }

  getCollection(id: string): CollectionRow | null {
    const row = this.db
      .prepare("SELECT id, name, royalty_bps, royalty_recipient FROM collections WHERE id = ?")
      .get(id) as
      | { id: string; name: string; royalty_bps: number; royalty_recipient: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      royaltyBps: row.royalty_bps,
      royaltyRecipient: row.royalty_recipient,
    };
  }

  listCollections(): CollectionRow[] {
    const rows = this.db
      .prepare("SELECT id, name, royalty_bps, royalty_recipient FROM collections ORDER BY id")
      .all() as unknown as {
      id: string;
      name: string;
      royalty_bps: number;
      royalty_recipient: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      royaltyBps: r.royalty_bps,
      royaltyRecipient: r.royalty_recipient,
    }));
  }

  updateCollectionRoyalty(id: string, bps: number, recipient: string): void {
    this.db
      .prepare("UPDATE collections SET royalty_bps = ?, royalty_recipient = ? WHERE id = ?")
      .run(bps, recipient, id);
  }

  getToken(id: string): TokenRow | null {
    const row = this.db
      .prepare("SELECT id, collection_id, owner_id FROM tokens WHERE id = ?")
      .get(id) as { id: string; collection_id: string; owner_id: string } | undefined;
    if (!row) return null;
    return { id: row.id, collectionId: row.collection_id, ownerId: row.owner_id };
  }

  listTokens(): TokenRow[] {
    const rows = this.db
      .prepare("SELECT id, collection_id, owner_id FROM tokens ORDER BY id")
      .all() as unknown as { id: string; collection_id: string; owner_id: string }[];
    return rows.map((r) => ({ id: r.id, collectionId: r.collection_id, ownerId: r.owner_id }));
  }

  getAccount(userId: string): AccountRow | null {
    const row = this.db
      .prepare("SELECT user_id, available, frozen FROM accounts WHERE user_id = ?")
      .get(userId) as { user_id: string; available: number; frozen: number } | undefined;
    if (!row) return null;
    return { userId: row.user_id, available: row.available, frozen: row.frozen };
  }

  listAccounts(): AccountRow[] {
    const rows = this.db
      .prepare("SELECT user_id, available, frozen FROM accounts ORDER BY user_id")
      .all() as unknown as { user_id: string; available: number; frozen: number }[];
    return rows.map((r) => ({ userId: r.user_id, available: r.available, frozen: r.frozen }));
  }

  getBid(id: string): BidRow | null {
    const row = this.db.prepare("SELECT * FROM bids WHERE id = ?").get(id) as
      | RawBid
      | undefined;
    return row ? toBid(row) : null;
  }

  listBids(): BidRow[] {
    const rows = this.db.prepare("SELECT * FROM bids ORDER BY created_seq, id").all() as unknown as RawBid[];
    return rows.map(toBid);
  }

  /** Sum of available + frozen across every account; must stay constant. */
  totalBalances(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(available + frozen), 0) AS total FROM accounts")
      .get() as { total: number };
    return row.total;
  }

  insertDiag(event: {
    runId: string;
    commitSeq: number | null;
    bidId: string | null;
    eventType: string;
    fromStatus: string | null;
    toStatus: string | null;
    reason: string | null;
    detail: Record<string, unknown> | null;
  }): void {
    this.db
      .prepare(
        "INSERT INTO diag_events (run_id, commit_seq, bid_id, event_type, from_status, to_status, reason, detail) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.runId,
        event.commitSeq,
        event.bidId,
        event.eventType,
        event.fromStatus,
        event.toStatus,
        event.reason,
        event.detail === null ? null : JSON.stringify(event.detail),
      );
  }

  listDiag(bidId?: string): DiagEventRow[] {
    const rows = (
      bidId
        ? this.db
            .prepare("SELECT * FROM diag_events WHERE bid_id = ? ORDER BY id")
            .all(bidId)
        : this.db.prepare("SELECT * FROM diag_events ORDER BY id").all()
    ) as unknown as {
      id: number;
      run_id: string;
      commit_seq: number | null;
      bid_id: string | null;
      event_type: string;
      from_status: string | null;
      to_status: string | null;
      reason: string | null;
      detail: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      commitSeq: r.commit_seq,
      bidId: r.bid_id,
      eventType: r.event_type,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      reason: r.reason,
      detail: r.detail === null ? null : (JSON.parse(r.detail) as Record<string, unknown>),
    }));
  }
}
