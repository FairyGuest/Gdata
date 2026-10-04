import { DatabaseSync } from 'node:sqlite';
import { inputError, stateError } from '../contract/errors.ts';
import type { CatalogView, CollectionConfig, TokenRecord } from '../contract/parse.ts';
import { migrate } from './schema.ts';

export type OrderStatus = 'open' | 'filled' | 'cancelled';

export interface OrderRecord {
  id: string;
  tokenId: string;
  collectionId: string;
  sellerId: string;
  price: number;
  royaltyBps: number;
  royaltyRecipient: string;
  status: OrderStatus;
  buyerId: string | null;
  createdSeq: number;
  commitSeq: number | null;
}

export interface FillRecord {
  orderId: string;
  buyerId: string;
  sellerId: string;
  price: number;
  royalty: number;
  sellerProceeds: number;
  royaltyRecipient: string;
  commitSeq: number;
  runId: string;
}

export interface OrderEventRecord {
  seq: number;
  runId: string;
  requestId: string;
  orderId: string | null;
  transition: string;
  reason: string | null;
  detail: string | null;
}

export interface UserRow {
  id: string;
  balance: number;
}

interface Row {
  [key: string]: unknown;
}

function asNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : (value as number);
}

function mapCollection(row: Row): CollectionConfig {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    royaltyBps: asNumber(row['royalty_bps']),
    royaltyRecipient: row['royalty_recipient'] as string,
    soulbound: asNumber(row['soulbound']) === 1,
  };
}

function mapToken(row: Row): TokenRecord {
  return {
    id: row['id'] as string,
    collectionId: row['collection_id'] as string,
    ownerId: row['owner_id'] as string,
  };
}

function mapOrder(row: Row): OrderRecord {
  return {
    id: row['id'] as string,
    tokenId: row['token_id'] as string,
    collectionId: row['collection_id'] as string,
    sellerId: row['seller_id'] as string,
    price: asNumber(row['price']),
    royaltyBps: asNumber(row['royalty_bps']),
    royaltyRecipient: row['royalty_recipient'] as string,
    status: row['status'] as OrderStatus,
    buyerId: (row['buyer_id'] as string | null) ?? null,
    createdSeq: asNumber(row['created_seq']),
    commitSeq: row['commit_seq'] === null ? null : asNumber(row['commit_seq']),
  };
}

/**
 * SQLite-backed ledger: ownership, balances and the order book.
 * All multi-statement mutations go through tx(), which uses BEGIN IMMEDIATE
 * so writers serialize on the database lock; the commit sequence counter
 * (meta key 'commit_seq') is only advanced inside a committed fill.
 */
export class Ledger implements CatalogView {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 2000');
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // connection already rolled back
      }
      throw err;
    }
  }

  // ---- meta / monotonic counters ------------------------------------------

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
    return row === undefined ? undefined : (row['value'] as string);
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** Monotonic counter living inside the ledger; only advances on commit. */
  nextSeq(key: string): number {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING').run(key, '0');
    this.db.prepare('UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = ?').run(key);
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row;
    return Number(row['value']);
  }

  // ---- catalog view ---------------------------------------------------------

  getCollection(id: string): CollectionConfig | undefined {
    const row = this.db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? undefined : mapCollection(row);
  }

  listCollections(): CollectionConfig[] {
    return (this.db.prepare('SELECT * FROM collections ORDER BY id').all() as Row[]).map(mapCollection);
  }

  getToken(id: string): TokenRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tokens WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? undefined : mapToken(row);
  }

  listTokens(): TokenRecord[] {
    return (this.db.prepare('SELECT * FROM tokens ORDER BY id').all() as Row[]).map(mapToken);
  }

  userExists(id: string): boolean {
    return this.db.prepare('SELECT 1 AS x FROM users WHERE id = ?').get(id) !== undefined;
  }

  getBalance(id: string): number | undefined {
    const row = this.db.prepare('SELECT balance FROM users WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? undefined : asNumber(row['balance']);
  }

  listUsers(): UserRow[] {
    return (this.db.prepare('SELECT id, balance FROM users ORDER BY id').all() as Row[]).map((row) => ({
      id: row['id'] as string,
      balance: asNumber(row['balance']),
    }));
  }

  sumBalances(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(balance), 0) AS total FROM users').get() as Row;
    return asNumber(row['total']);
  }

  // ---- fixture / collection writes ------------------------------------------

  insertCollection(config: CollectionConfig): void {
    this.db
      .prepare('INSERT INTO collections (id, name, royalty_bps, royalty_recipient, soulbound) VALUES (?, ?, ?, ?, ?)')
      .run(config.id, config.name, config.royaltyBps, config.royaltyRecipient, config.soulbound ? 1 : 0);
  }

  insertUser(user: UserRow): void {
    this.db.prepare('INSERT INTO users (id, balance) VALUES (?, ?)').run(user.id, user.balance);
  }

  insertToken(token: TokenRecord): void {
    this.db.prepare('INSERT INTO tokens (id, collection_id, owner_id) VALUES (?, ?, ?)').run(token.id, token.collectionId, token.ownerId);
  }

  // ---- order book -------------------------------------------------------------

  insertOrder(order: OrderRecord): void {
    this.db
      .prepare(
        'INSERT INTO orders (id, token_id, collection_id, seller_id, price, royalty_bps, royalty_recipient, status, buyer_id, created_seq, commit_seq)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        order.id,
        order.tokenId,
        order.collectionId,
        order.sellerId,
        order.price,
        order.royaltyBps,
        order.royaltyRecipient,
        order.status,
        order.buyerId,
        order.createdSeq,
        order.commitSeq,
      );
  }

  getOrder(id: string): OrderRecord | undefined {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? undefined : mapOrder(row);
  }

  getOpenOrderForToken(tokenId: string): OrderRecord | undefined {
    const row = this.db.prepare("SELECT * FROM orders WHERE token_id = ? AND status = 'open'").get(tokenId) as Row | undefined;
    return row === undefined ? undefined : mapOrder(row);
  }

  listOrders(): OrderRecord[] {
    return (this.db.prepare('SELECT * FROM orders ORDER BY created_seq').all() as Row[]).map(mapOrder);
  }

  setOrderCancelled(id: string): void {
    this.db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(id);
  }

  setOrderFilled(id: string, buyerId: string, commitSeq: number): void {
    this.db.prepare("UPDATE orders SET status = 'filled', buyer_id = ?, commit_seq = ? WHERE id = ?").run(buyerId, commitSeq, id);
  }

  // ---- ownership & balances ---------------------------------------------------

  transferToken(tokenId: string, newOwnerId: string): void {
    this.db.prepare('UPDATE tokens SET owner_id = ? WHERE id = ?').run(newOwnerId, tokenId);
  }

  debit(userId: string, amount: number): void {
    const res = this.db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?').run(amount, userId, amount);
    if (res.changes === 0) {
      const balance = this.getBalance(userId);
      if (balance === undefined) {
        throw inputError('unknown_user', 'unknown user "' + userId + '"', { userId });
      }
      throw stateError('insufficient_balance', 'user "' + userId + '" balance ' + String(balance) + ' < ' + String(amount), {
        userId,
        balance,
        required: amount,
      });
    }
  }

  credit(userId: string, amount: number): void {
    const res = this.db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, userId);
    if (res.changes === 0) {
      throw inputError('unknown_user', 'unknown user "' + userId + '"', { userId });
    }
  }

  // ---- fills & diag events ------------------------------------------------------

  insertFill(fill: FillRecord): void {
    this.db
      .prepare(
        'INSERT INTO fills (order_id, buyer_id, seller_id, price, royalty, seller_proceeds, royalty_recipient, commit_seq, run_id)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(fill.orderId, fill.buyerId, fill.sellerId, fill.price, fill.royalty, fill.sellerProceeds, fill.royaltyRecipient, fill.commitSeq, fill.runId);
  }

  getFill(orderId: string): FillRecord | undefined {
    const row = this.db.prepare('SELECT * FROM fills WHERE order_id = ?').get(orderId) as Row | undefined;
    if (row === undefined) return undefined;
    return {
      orderId: row['order_id'] as string,
      buyerId: row['buyer_id'] as string,
      sellerId: row['seller_id'] as string,
      price: asNumber(row['price']),
      royalty: asNumber(row['royalty']),
      sellerProceeds: asNumber(row['seller_proceeds']),
      royaltyRecipient: row['royalty_recipient'] as string,
      commitSeq: asNumber(row['commit_seq']),
      runId: row['run_id'] as string,
    };
  }

  countFills(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM fills').get() as Row;
    return asNumber(row['n']);
  }

  insertEvent(event: Omit<OrderEventRecord, 'seq'>): void {
    this.db
      .prepare('INSERT INTO order_events (run_id, request_id, order_id, transition, reason, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(event.runId, event.requestId, event.orderId, event.transition, event.reason, event.detail);
  }

  getEvents(orderId: string): OrderEventRecord[] {
    const rows = this.db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY seq').all(orderId) as Row[];
    return rows.map(mapEvent);
  }

  getAllEvents(): OrderEventRecord[] {
    const rows = this.db.prepare('SELECT * FROM order_events ORDER BY seq').all() as Row[];
    return rows.map(mapEvent);
  }
}

function mapEvent(row: Row): OrderEventRecord {
  return {
    seq: asNumber(row['seq']),
    runId: row['run_id'] as string,
    requestId: row['request_id'] as string,
    orderId: (row['order_id'] as string | null) ?? null,
    transition: row['transition'] as string,
    reason: (row['reason'] as string | null) ?? null,
    detail: (row['detail'] as string | null) ?? null,
  };
}
