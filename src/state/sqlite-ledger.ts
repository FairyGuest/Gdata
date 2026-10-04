import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  CollectionRecord,
  OrderRecord,
  OrderStatus,
  TokenRecord,
  UserRecord,
} from '../contract/types.js';
import { ErrorReason, MarketError } from '../errors.js';
import { SEED_FIXTURE } from '../fixtures/seed-fixture.js';
import { validateBps } from '../contract/primitives.js';
import { migrate } from './migrations.js';
import {
  CommitKind,
  LedgerTransaction,
  ListingInsert,
  SettlementResult,
} from './ports.js';

interface OrderRow {
  id: string;
  collection_id: string;
  token_id: string;
  seller: string;
  buyer: string | null;
  price: number;
  status: OrderStatus;
  royalty_bps_snapshot: number;
  royalty_recipient_snapshot: string;
  soulbound_snapshot: number;
  created_commit_seq: number;
  filled_commit_seq: number | null;
  cancelled_commit_seq: number | null;
}

export interface TransactionContext<T> {
  runId: string;
  kind: CommitKind;
  refId: string;
  initialDetail?: Record<string, unknown>;
  work: (tx: LedgerTransaction) => T;
}

const FIND_COLLECTION_SQL = 'SELECT * FROM collections WHERE id = ?';
const FIND_TOKEN_SQL = 'SELECT * FROM tokens WHERE collection_id = ? AND token_id = ?';
const FIND_USER_SQL = 'SELECT * FROM users WHERE id = ?';
const FIND_ORDER_SQL = 'SELECT * FROM orders WHERE id = ?';

export class SqliteLedger {
  private readonly db: DatabaseSync;
  private writerChain: Promise<unknown> = Promise.resolve();
  private unavailable = false;
  private readonly dbPath: string;

  constructor(dbPath: string, private readonly lockWaitMs: number) {
    this.dbPath = dbPath;
    try {
      if (this.dbPath !== ':memory:') {
        mkdirSync(dirname(this.dbPath), { recursive: true });
      }
      this.db = new DatabaseSync(this.dbPath, {
        enableForeignKeyConstraints: true,
        timeout: this.lockWaitMs,
      });
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec('PRAGMA foreign_keys = ON');
      migrate(this.db);
      this.seedIfEmpty();
    } catch (error) {
      throw toStorageError(error, 'failed to open or initialize storage');
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch (error) {
      throw toStorageError(error, 'failed to close storage');
    }
  }

  setUnavailable(value: boolean): void {
    this.unavailable = value;
  }

  isUnavailable(): boolean {
    return this.unavailable || !this.db.isOpen;
  }

  holdExternalWriteLock(): () => void {
    if (this.dbPath === ":memory:") {
      throw new MarketError(
        "resource",
        ErrorReason.StorageUnavailable,
        "Cross-connection lock probes require a file-backed database",
      );
    }
    const external = new DatabaseSync(this.dbPath, { timeout: 0 });
    external.exec("BEGIN IMMEDIATE");
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        if (external.isTransaction) external.exec("ROLLBACK");
      } finally {
        external.close();
      }
    };
  }

  findCollection(id: string): CollectionRecord | null {
    return this.read(() => mapCollection(this.db.prepare(FIND_COLLECTION_SQL).get(id)));
  }

  findToken(collectionId: string, tokenId: string): TokenRecord | null {
    return this.read(() =>
      mapToken(this.db.prepare(FIND_TOKEN_SQL).get(collectionId, tokenId)),
    );
  }

  findUser(id: string): UserRecord | null {
    return this.read(() => mapUser(this.db.prepare(FIND_USER_SQL).get(id)));
  }

  findOrder(id: string): OrderRecord | null {
    return this.read(() => mapOrder(this.db.prepare(FIND_ORDER_SQL).get(id)));
  }

  listOrders(): OrderRecord[] {
    return this.read(() =>
      this.db
        .prepare('SELECT * FROM orders ORDER BY created_commit_seq ASC, id ASC')
        .all()
        .map((row) => mapOrder(row)).filter((item): item is NonNullable<typeof item> => item !== null),
    );
  }

  listUsers(): UserRecord[] {
    return this.read(() =>
      this.db
        .prepare('SELECT * FROM users ORDER BY id ASC')
        .all()
        .map((row) => mapUser(row)).filter((item): item is NonNullable<typeof item> => item !== null),
    );
  }

  listCommits(limit = 100): Array<Record<string, unknown>> {
    return this.read(() =>
      this.db
        .prepare('SELECT * FROM commit_log ORDER BY seq DESC LIMIT ?')
        .all(limit)
        .reverse()
        .map((raw) => {
          const row = raw as {
            seq: number;
            run_id: string;
            kind: string;
            ref_id: string;
            detail_json: string;
          };
          return {
            seq: row.seq,
            runId: row.run_id,
            kind: row.kind,
            refId: row.ref_id,
            detail: JSON.parse(row.detail_json) as unknown,
          };
        }),
    );
  }

  listTransfers(orderId?: string): Array<Record<string, unknown>> {
    return this.read(() => {
      const rows = orderId
        ? this.db
            .prepare('SELECT * FROM transfers WHERE order_id = ? ORDER BY id ASC')
            .all(orderId)
        : this.db.prepare('SELECT * FROM transfers ORDER BY id ASC LIMIT 200').all();
      return rows.map((raw) => {
        const row = raw as {
          commit_seq: number;
          order_id: string;
          account_user: string;
          direction: 'debit' | 'credit';
          amount: number;
          classification: string;
        };
        return {
          commitSeq: row.commit_seq,
          orderId: row.order_id,
          account: row.account_user,
          direction: row.direction,
          amount: row.amount,
          classification: row.classification,
        };
      });
    });
  }

  withTransaction<T>(context: TransactionContext<T>): Promise<T> {
    const run = this.writerChain.then(() => this.executeTransaction(context));
    this.writerChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private executeTransaction<T>(context: TransactionContext<T>): T {
    if (this.isUnavailable()) {
      throw new MarketError(
        'resource',
        ErrorReason.StorageUnavailable,
        'Storage is unavailable',
        { runId: context.runId },
      );
    }

    try {
      this.db.exec('BEGIN IMMEDIATE');
      const seq = allocateCommitSeq(this.db);
      const tx = new SqliteTransaction(this.db, context.runId, seq, context.kind, context.refId);
      tx.appendCommitDetail(context.initialDetail ?? {});
      const result = context.work(tx);
      tx.writeCommitLog();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      if (error instanceof MarketError) throw error;
      if (isLockTimeout(error)) {
        throw new MarketError(
          'resource',
          ErrorReason.LockTimeout,
          'Timed out waiting for the SQLite writer lock',
          { runId: context.runId },
        );
      }
      throw toStorageError(error, 'storage transaction failed');
    }
  }

  private read<T>(work: () => T): T {
    if (this.isUnavailable()) {
      throw new MarketError('resource', ErrorReason.StorageUnavailable, 'Storage is unavailable');
    }
    try {
      return work();
    } catch (error) {
      if (error instanceof MarketError) throw error;
      throw toStorageError(error, 'storage read failed');
    }
  }
  private seedIfEmpty(): void {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    if (row.count > 0) return;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insertUser = this.db.prepare('INSERT INTO users (id, balance) VALUES (?, ?)');
      for (const [id, balance] of Object.entries(SEED_FIXTURE.users)) {
        insertUser.run(id, balance);
      }

      const insertCollection = this.db.prepare(
        'INSERT INTO collections (id, royalty_bps, royalty_recipient, soulbound, version) VALUES (?, ?, ?, ?, 1)',
      );
      for (const collection of SEED_FIXTURE.collections) {
        validateBps(collection.royaltyBps, 'fixture.royaltyBps');
        insertCollection.run(
          collection.id,
          collection.royaltyBps,
          collection.royaltyRecipient,
          collection.soulbound ? 1 : 0,
        );
      }

      const insertToken = this.db.prepare(
        'INSERT INTO tokens (collection_id, token_id, owner) VALUES (?, ?, ?)',
      );
      for (const token of SEED_FIXTURE.tokens) {
        insertToken.run(token.collectionId, token.tokenId, token.owner);
      }

      const insertSeededOrder = this.db.prepare(
        'INSERT INTO orders (id, collection_id, token_id, seller, buyer, price, status, royalty_bps_snapshot, royalty_recipient_snapshot, soulbound_snapshot, created_commit_seq, filled_commit_seq, cancelled_commit_seq) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, NULL, NULL)',
      );
      for (const order of SEED_FIXTURE.orders) {
        const collection = SEED_FIXTURE.collections.find((item) => item.id === order.collectionId);
        if (!collection) throw new Error('fixture order ' + order.id + ' missing collection');
        insertSeededOrder.run(
          order.id,
          order.collectionId,
          order.tokenId,
          order.seller,
          order.price,
          'active',
          collection.royaltyBps,
          collection.royaltyRecipient,
          order.soulboundSnapshot ? 1 : 0,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

class SqliteTransaction implements LedgerTransaction {
  private detail: Record<string, unknown> = {};
  private refId: string;

  constructor(
    private readonly db: DatabaseSync,
    readonly runId: string,
    readonly commitSeq: number,
    private readonly kind: CommitKind,
    initialRefId: string,
  ) {
    this.refId = initialRefId;
    db.prepare(
      'INSERT INTO commit_log (seq, run_id, kind, ref_id, detail_json) VALUES (?, ?, ?, ?, ?)',
    ).run(commitSeq, runId, kind, this.refId, '{}');
  }

  getCollection(id: string): CollectionRecord | null {
    return mapCollection(this.db.prepare(FIND_COLLECTION_SQL).get(id));
  }

  getUser(id: string): UserRecord | null {
    return mapUser(this.db.prepare(FIND_USER_SQL).get(id));
  }

  getToken(collectionId: string, tokenId: string): TokenRecord | null {
    return mapToken(this.db.prepare(FIND_TOKEN_SQL).get(collectionId, tokenId));
  }

  getOrder(id: string): OrderRecord | null {
    return mapOrder(this.db.prepare(FIND_ORDER_SQL).get(id));
  }

  findActiveOrder(collectionId: string, tokenId: string): OrderRecord | null {
    return mapOrder(
      this.db
        .prepare('SELECT * FROM orders WHERE collection_id = ? AND token_id = ? AND status = ?')
        .get(collectionId, tokenId, 'active'),
    );
  }

  insertListing(input: ListingInsert): OrderRecord {
    const id = 'ord-' + String(this.commitSeq).padStart(6, '0');
    this.refId = id;
    try {
      this.db
        .prepare(
          'INSERT INTO orders (id, collection_id, token_id, seller, buyer, price, status, royalty_bps_snapshot, royalty_recipient_snapshot, soulbound_snapshot, created_commit_seq, filled_commit_seq, cancelled_commit_seq) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL)',
        )
        .run(
          id,
          input.collectionId,
          input.tokenId,
          input.seller,
          input.price,
          'active',
          input.royaltyBpsSnapshot,
          input.royaltyRecipientSnapshot,
          input.soulboundSnapshot ? 1 : 0,
          this.commitSeq,
        );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new MarketError(
          'state',
          ErrorReason.DuplicateListing,
          'Token already has an active listing',
          { collectionId: input.collectionId, tokenId: input.tokenId },
        );
      }
      throw error;
    }
    return this.getOrder(id)!;
  }

  cancelOrder(order: OrderRecord): void {
    this.refId = order.id;
    const result = this.db
      .prepare(
        'UPDATE orders SET status = ?, cancelled_commit_seq = ? WHERE id = ? AND status = ?',
      )
      .run('cancelled', this.commitSeq, order.id, 'active');
    if (result.changes !== 1) {
      throw new MarketError(
        'state',
        ErrorReason.OrderAlreadyCancelled,
        'Order ' + order.id + ' is not active and cannot be cancelled',
        { orderId: order.id, currentStatus: this.getOrder(order.id)?.status ?? null },
      );
    }
  }

  settleOrder(input: {
    order: OrderRecord;
    buyer: string;
    nextOwner: string;
    royaltyRecipient: string;
    royaltyAmount: number;
    sellerProceeds: number;
    detail: Record<string, unknown>;
  }): SettlementResult {
    const { order, buyer, nextOwner } = input;
    const totalBalanceBefore = this.totalBalance();
    const tokenCountBefore = this.countTokens();

    const buyerBefore = this.getUser(buyer);
    const sellerBefore = this.getUser(order.seller);
    const recipientBefore = this.getUser(input.royaltyRecipient);
    if (!buyerBefore || !sellerBefore || !recipientBefore) {
      throw new MarketError(
        'computation',
        ErrorReason.Unexpected,
        'Settlement references a missing ledger account',
        { buyer, seller: order.seller, royaltyRecipient: input.royaltyRecipient },
      );
    }
    if (buyerBefore.balance < order.price) {
      throw new MarketError(
        'state',
        ErrorReason.InsufficientBalance,
        'Buyer balance is below listing price',
        {
          buyer,
          balance: buyerBefore.balance,
          required: order.price,
          orderId: order.id,
        },
      );
    }

    this.refId = order.id;
    const tokenResult = this.db
      .prepare(
        'UPDATE tokens SET owner = ? WHERE collection_id = ? AND token_id = ? AND owner = ?',
      )
      .run(nextOwner, order.collectionId, order.tokenId, order.seller);
    if (tokenResult.changes !== 1) {
      throw new MarketError(
        'state',
        ErrorReason.SellerNotHolder,
        'Seller no longer holds the listed token',
        {
          orderId: order.id,
          collectionId: order.collectionId,
          tokenId: order.tokenId,
          expectedHolder: order.seller,
        },
      );
    }

    const debitResult = this.db
      .prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?')
      .run(order.price, buyer, order.price);
    if (debitResult.changes !== 1) {
      throw new MarketError(
        'state',
        ErrorReason.InsufficientBalance,
        'Buyer balance changed below the required amount during settlement',
        { buyer, required: order.price, orderId: order.id },
      );
    }
    this.db
      .prepare('UPDATE users SET balance = balance + ? WHERE id = ?')
      .run(input.sellerProceeds, order.seller);
    this.db
      .prepare('UPDATE users SET balance = balance + ? WHERE id = ?')
      .run(input.royaltyAmount, input.royaltyRecipient);

    this.insertTransfer(buyer, 'debit', order.price, 'buyer_price');
    this.insertTransfer(order.seller, 'credit', input.sellerProceeds, 'seller_proceeds');
    this.insertTransfer(
      input.royaltyRecipient,
      'credit',
      input.royaltyAmount,
      'royalty',
    );

    const token = this.getToken(order.collectionId, order.tokenId)!;
    const affectedUsers = [buyer, order.seller, input.royaltyRecipient]
      .filter((account, index, accounts) => accounts.indexOf(account) === index)
      .map((account) => this.getUser(account)!);
    const totalBalanceAfter = this.totalBalance();
    const tokenCountAfter = this.countTokens();

    const transferEntries = this.db
      .prepare('SELECT account_user, direction, amount, classification FROM transfers WHERE commit_seq = ? ORDER BY id ASC')
      .all(this.commitSeq)
      .map((raw) => {
        const row = raw as {
          account_user: string;
          direction: 'debit' | 'credit';
          amount: number;
          classification: string;
        };
        return {
          account: row.account_user,
          direction: row.direction,
          amount: row.amount,
          classification: row.classification,
        };
      });

    const debitSum = sumByDirection(transferEntries, 'debit');
    const creditSum = sumByDirection(transferEntries, 'credit');
    if (
      totalBalanceAfter !== totalBalanceBefore ||
      tokenCountAfter !== tokenCountBefore ||
      debitSum !== order.price ||
      creditSum !== order.price ||
      input.sellerProceeds + input.royaltyAmount !== order.price
    ) {
      throw new MarketError(
        'computation',
        ErrorReason.ConservationViolation,
        'Settlement violates ledger conservation invariants',
        {
          orderId: order.id,
          totalBalanceBefore,
          totalBalanceAfter,
          tokenCountBefore,
          tokenCountAfter,
          debitSum,
          creditSum,
          sellerProceeds: input.sellerProceeds,
          royaltyAmount: input.royaltyAmount,
        },
      );
    }

    const orderResult = this.db
      .prepare(
        'UPDATE orders SET status = ?, buyer = ?, filled_commit_seq = ? WHERE id = ? AND status = ?',
      )
      .run('filled', buyer, this.commitSeq, order.id, 'active');
    if (orderResult.changes !== 1) {
      throw new MarketError(
        'state',
        ErrorReason.OrderAlreadyFilled,
        'Order ' + order.id + ' is no longer active',
        { orderId: order.id, commitSeq: this.commitSeq },
      );
    }

    this.appendCommitDetail({
      settlement: {
        ...input.detail,
        buyer,
        seller: order.seller,
        royaltyRecipient: input.royaltyRecipient,
        grossPrice: order.price,
        royaltyAmount: input.royaltyAmount,
        sellerProceeds: input.sellerProceeds,
        newOwner: token.owner,
        totalBalanceBefore,
        totalBalanceAfter,
      },
    });

    return {
      order: this.getOrder(order.id)!,
      token,
      affectedUsers,
      totalBalanceBefore,
      totalBalanceAfter,
      tokenCountBefore,
      tokenCountAfter,
      transferEntries,
    };
  }

  updateCollectionRoyalty(input: {
    collection: CollectionRecord;
    royaltyBps: number;
    reason: string;
  }): CollectionRecord {
    validateBps(input.royaltyBps, 'royaltyBps');
    this.db
      .prepare(
        'UPDATE collections SET royalty_bps = ?, version = version + 1 WHERE id = ?',
      )
      .run(input.royaltyBps, input.collection.id);
    this.appendCommitDetail({
      configChange: {
        collectionId: input.collection.id,
        previousBps: input.collection.royaltyBps,
        nextBps: input.royaltyBps,
        reason: input.reason,
      },
    });
    return this.getCollection(input.collection.id)!;
  }

  transferTokenForTest(input: {
    token: TokenRecord;
    nextOwner: string;
    reason: string;
  }): TokenRecord {
    if (!this.getUser(input.nextOwner)) {
      throw new MarketError(
        'input',
        ErrorReason.UnknownUser,
        'Cannot transfer token to unknown user',
        { nextOwner: input.nextOwner },
      );
    }
    const result = this.db
      .prepare(
        'UPDATE tokens SET owner = ? WHERE collection_id = ? AND token_id = ? AND owner = ?',
      )
      .run(input.nextOwner, input.token.collectionId, input.token.id, input.token.owner);
    if (result.changes !== 1) {
      throw new MarketError(
        'computation',
        ErrorReason.Unexpected,
        'Test ownership transfer affected an unexpected number of rows',
        { token: input.token, expectedChanges: 1, actualChanges: result.changes },
      );
    }
    this.appendCommitDetail({
      testOwnershipTransfer: {
        collectionId: input.token.collectionId,
        tokenId: input.token.id,
        from: input.token.owner,
        to: input.nextOwner,
        reason: input.reason,
      },
    });
    return this.getToken(input.token.collectionId, input.token.id)!;
  }

  totalBalance(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(balance), 0) AS total FROM users').get() as {
      total: number;
    };
    return row.total;
  }

  countTokens(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM tokens').get() as { count: number };
    return row.count;
  }

  appendCommitDetail(detail: Record<string, unknown>): void {
    Object.assign(this.detail, detail);
  }

  writeCommitLog(): void {
    this.db
      .prepare('UPDATE commit_log SET ref_id = ?, detail_json = ? WHERE seq = ?')
      .run(this.refId, JSON.stringify(this.detail), this.commitSeq);
  }

  private insertTransfer(
    account: string,
    direction: 'debit' | 'credit',
    amount: number,
    classification: string,
  ): void {
    this.db
      .prepare(
        'INSERT INTO transfers (commit_seq, order_id, account_user, direction, amount, classification) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(this.commitSeq, this.refId, account, direction, amount, classification);
  }
}

function allocateCommitSeq(db: DatabaseSync): number {
  const result = db.prepare('UPDATE commit_sequence SET value = value + 1 WHERE singleton = 1').run();
  if (result.changes !== 1) {
    throw new MarketError(
      'resource',
      ErrorReason.StorageUnavailable,
      'Commit sequence row is missing',
    );
  }
  const row = db.prepare('SELECT value FROM commit_sequence WHERE singleton = 1').get() as {
    value: number;
  };
  return row.value;
}

function sumByDirection(
  entries: Array<{ direction: 'debit' | 'credit'; amount: number }>,
  direction: 'debit' | 'credit',
): number {
  return entries
    .filter((entry) => entry.direction === direction)
    .reduce((total, entry) => total + entry.amount, 0);
}

function mapCollection(raw: unknown): CollectionRecord | null {
  if (!raw) return null;
  const row = raw as {
    id: string;
    royalty_bps: number;
    royalty_recipient: string;
    soulbound: number;
    version: number;
  };
  return {
    id: row.id,
    royaltyBps: row.royalty_bps,
    royaltyRecipient: row.royalty_recipient,
    soulbound: row.soulbound === 1,
    version: row.version,
  };
}

function mapUser(raw: unknown): UserRecord | null {
  if (!raw) return null;
  const row = raw as { id: string; balance: number };
  return { id: row.id, balance: row.balance };
}

function mapToken(raw: unknown): TokenRecord | null {
  if (!raw) return null;
  const row = raw as { collection_id: string; token_id: string; owner: string };
  return { id: row.token_id, collectionId: row.collection_id, owner: row.owner };
}

function mapOrder(raw: unknown): OrderRecord | null {
  if (!raw) return null;
  const row = raw as OrderRow;
  return {
    id: row.id,
    collectionId: row.collection_id,
    tokenId: row.token_id,
    seller: row.seller,
    buyer: row.buyer,
    price: row.price,
    status: row.status,
    royaltyBpsSnapshot: row.royalty_bps_snapshot,
    royaltyRecipientSnapshot: row.royalty_recipient_snapshot,
    soulboundSnapshot: row.soulbound_snapshot === 1,
    createdCommitSeq: row.created_commit_seq,
    filledCommitSeq: row.filled_commit_seq,
    cancelledCommitSeq: row.cancelled_commit_seq,
  };
}

function isUniqueConstraint(error: unknown): boolean {
  return hasSqliteCode(error, 'SQLITE_CONSTRAINT_UNIQUE') || hasErrorCode(error, 2067);
}

function isLockTimeout(error: unknown): boolean {
  if (hasSqliteCode(error, 'SQLITE_BUSY') || hasSqliteCode(error, 'SQLITE_LOCKED')) {
    return true;
  }
  if (!hasSqliteCode(error, 'ERR_SQLITE_ERROR')) return false;
  const message = typeof error === 'object' && error !== null
    ? String((error as { message?: unknown }).message ?? '')
    : '';
  return /database is locked|database table is locked|timeout/i.test(message);
}

function hasSqliteCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function hasErrorCode(error: unknown, code: number): boolean {
  return typeof error === 'object' && error !== null && (error as { errno?: unknown }).errno === code;
}

function toStorageError(error: unknown, message: string): MarketError {
  if (error instanceof MarketError) return error;
  return new MarketError(
    'resource',
    ErrorReason.StorageUnavailable,
    message,
    {
      message: error instanceof Error ? error.message : String(error),
    },
  );
}