// State adapter: SQLite event log + projection tables + rebuild support.
// The kernel talks to this module only through the small function set below;
// SQL never leaks upward.

import { DatabaseSync } from 'node:sqlite';
import type { NftEvent } from '../contract/events.ts';
import { canonicalEvent } from '../contract/events.ts';

export interface Stats {
  volume: number;
  floor: number | null;
  salesCount: number;
}

export interface StoredEvent extends NftEvent {
  canonical: string;
}

export interface Rejection {
  id: number;
  runId: string;
  seq: number | null;
  reason: string;
  detail: string;
}

export class ResourceError extends Error {
  readonly status = 503;
  readonly reason = 'resource_exhausted';
  constructor(detail: string) {
    super(detail);
    this.name = 'ResourceError';
  }
}

export function openDatabase(path: string): DatabaseSync {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (err) {
    throw new ResourceError('cannot open database at ' + path + ': ' + (err as Error).message);
  }
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      token_id TEXT NOT NULL,
      from_addr TEXT,
      to_addr TEXT NOT NULL,
      price INTEGER,
      canonical TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ownership (
      token_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      updated_seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS token_stats (
      token_id TEXT PRIMARY KEY,
      last_sale_seq INTEGER NOT NULL,
      last_sale_price INTEGER NOT NULL,
      last_sale_from TEXT NOT NULL,
      last_sale_to TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stats (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      volume INTEGER NOT NULL,
      floor INTEGER,
      sales_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rejections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      seq INTEGER,
      reason TEXT NOT NULL,
      detail TEXT NOT NULL
    );
    INSERT OR IGNORE INTO meta (key, value) VALUES ('appliedSeq', '0');
    INSERT OR IGNORE INTO stats (id, volume, floor, sales_count) VALUES (1, 0, NULL, 0);
  `);
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (/SQLITE_FULL|database or disk is full|SQLITE_BUSY|locked/i.test(msg)) {
      throw new ResourceError(msg);
    }
    throw err;
  }
}

export function getAppliedSeq(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'appliedSeq'").get() as { value: string };
  return Number(row.value);
}

export function setAppliedSeq(db: DatabaseSync, seq: number): void {
  db.prepare("UPDATE meta SET value = ? WHERE key = 'appliedSeq'").run(String(seq));
}

export function getEventBySeq(db: DatabaseSync, seq: number): StoredEvent | null {
  const row = db.prepare('SELECT * FROM events WHERE seq = ?').get(seq) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    seq: row.seq as number,
    type: row.type as NftEvent['type'],
    tokenId: row.token_id as string,
    from: (row.from_addr as string | null) ?? null,
    to: row.to_addr as string,
    price: (row.price as number | null) ?? null,
    canonical: row.canonical as string,
  };
}

export function maxLoggedSeq(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM events').get() as { m: number };
  return row.m;
}

export function listEventsUpTo(db: DatabaseSync, toSeq: number): NftEvent[] {
  const rows = db.prepare('SELECT * FROM events WHERE seq <= ? ORDER BY seq ASC').all(toSeq) as Record<string, unknown>[];
  return rows.map((row) => ({
    seq: row.seq as number,
    type: row.type as NftEvent['type'],
    tokenId: row.token_id as string,
    from: (row.from_addr as string | null) ?? null,
    to: row.to_addr as string,
    price: (row.price as number | null) ?? null,
  }));
}

export function insertEvent(db: DatabaseSync, ev: NftEvent): void {
  wrap(() => {
    db.prepare(
      'INSERT INTO events (seq, type, token_id, from_addr, to_addr, price, canonical) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(ev.seq, ev.type, ev.tokenId, ev.from, ev.to, ev.price, canonicalEvent(ev));
  });
}

export function getOwner(db: DatabaseSync, tokenId: string): string | null {
  const row = db.prepare('SELECT owner FROM ownership WHERE token_id = ?').get(tokenId) as { owner: string } | undefined;
  return row ? row.owner : null;
}

// Projection reducer shared by incremental ingest and rebuild. This is the
// single place where an event mutates the projection, so both paths are
// guaranteed to be the same pure function of the event log.
export function applyToProjection(db: DatabaseSync, ev: NftEvent): void {
  wrap(() => {
    if (ev.type === 'mint') {
      db.prepare('INSERT INTO ownership (token_id, owner, updated_seq) VALUES (?, ?, ?)').run(ev.tokenId, ev.to, ev.seq);
    } else {
      db.prepare('UPDATE ownership SET owner = ?, updated_seq = ? WHERE token_id = ?').run(ev.to, ev.seq, ev.tokenId);
    }
    if (ev.type === 'sale') {
      const price = ev.price as number;
      db.prepare(
        'INSERT INTO token_stats (token_id, last_sale_seq, last_sale_price, last_sale_from, last_sale_to) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT(token_id) DO UPDATE SET last_sale_seq = excluded.last_sale_seq, last_sale_price = excluded.last_sale_price, ' +
          'last_sale_from = excluded.last_sale_from, last_sale_to = excluded.last_sale_to',
      ).run(ev.tokenId, ev.seq, price, ev.from as string, ev.to);
      const stats = getStats(db);
      const floor = stats.floor === null ? price : Math.min(stats.floor, price);
      db.prepare('UPDATE stats SET volume = ?, floor = ?, sales_count = ? WHERE id = 1').run(
        stats.volume + price,
        floor,
        stats.salesCount + 1,
      );
    }
  });
}

export function getStats(db: DatabaseSync): Stats {
  const row = db.prepare('SELECT volume, floor, sales_count FROM stats WHERE id = 1').get() as {
    volume: number;
    floor: number | null;
    sales_count: number;
  };
  return { volume: row.volume, floor: row.floor, salesCount: row.sales_count };
}

export function listOwnership(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare('SELECT token_id, owner FROM ownership ORDER BY token_id ASC').all() as {
    token_id: string;
    owner: string;
  }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.token_id] = r.owner;
  return out;
}

export function listLastSales(db: DatabaseSync): Record<string, { seq: number; price: number; from: string; to: string }> {
  const rows = db.prepare('SELECT * FROM token_stats ORDER BY token_id ASC').all() as Record<string, unknown>[];
  const out: Record<string, { seq: number; price: number; from: string; to: string }> = {};
  for (const r of rows) {
    out[r.token_id as string] = {
      seq: r.last_sale_seq as number,
      price: r.last_sale_price as number,
      from: r.last_sale_from as string,
      to: r.last_sale_to as string,
    };
  }
  return out;
}

export function resetProjections(db: DatabaseSync): void {
  wrap(() => {
    db.exec('DELETE FROM ownership; DELETE FROM token_stats;');
    db.prepare('UPDATE stats SET volume = 0, floor = NULL, sales_count = 0 WHERE id = 1').run();
    setAppliedSeq(db, 0);
  });
}

export function logRejection(db: DatabaseSync, runId: string, seq: number | null, reason: string, detail: string): void {
  wrap(() => {
    db.prepare('INSERT INTO rejections (run_id, seq, reason, detail) VALUES (?, ?, ?, ?)').run(runId, seq, reason, detail);
  });
}

export function listRejections(db: DatabaseSync): Rejection[] {
  const rows = db.prepare('SELECT * FROM rejections ORDER BY id ASC').all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    runId: r.run_id as string,
    seq: (r.seq as number | null) ?? null,
    reason: r.reason as string,
    detail: r.detail as string,
  }));
}
