import type { DB } from "./db.js";
import { inTransaction } from "./db.js";
import { applyFeed } from "../kernel/evolve.js";
import type { CollectionTemplate } from "../kernel/render.js";
import { inputError, stateConflict, resourceExhausted, computeFailure } from "../contract/errors.js";

export interface TokenRow {
  token_id: number;
  collection_id: string;
  level: number;
  xp: number;
  total_fed: number;
  total_consumed: number;
}

export interface FeedReceipt {
  tokenId: number;
  level: number;
  xp: number;
  consumed: number;
  transitions: number;
  /** internal transaction commit sequence serializing concurrent feeds. */
  commitSeq: number;
}

function getToken(db: DB, tokenId: number): TokenRow {
  const row = db.prepare("SELECT * FROM tokens WHERE token_id = ?").get(tokenId) as TokenRow | undefined;
  if (!row) throw inputError("token_not_found", "no token with id " + tokenId);
  return row;
}

export function getTemplate(db: DB, collectionId: string): CollectionTemplate {
  const row = db.prepare("SELECT template_json FROM collections WHERE collection_id = ?").get(collectionId) as
    | { template_json: string }
    | undefined;
  if (!row) throw computeFailure("template_missing", "no template for collection " + collectionId);
  try {
    return JSON.parse(row.template_json) as CollectionTemplate;
  } catch {
    throw computeFailure("template_corrupt", "template JSON failed to parse");
  }
}

function getThresholds(db: DB, collectionId: string): number[] {
  const rows = db
    .prepare("SELECT xp_cost FROM thresholds WHERE collection_id = ? ORDER BY from_level")
    .all(collectionId) as Array<{ xp_cost: number }>;
  return rows.map((r) => Number(r.xp_cost));
}

/**
 * Apply one feed inside a single SQLite transaction: XP accounting, level
 * transitions and history row commit atomically. All writes go through one
 * connection guarded by BEGIN IMMEDIATE, so concurrent feeds serialize; the
 * AUTOINCREMENT transition seq is the commit order (no clock involved).
 */
export function feedToken(db: DB, tokenId: number, amount: number): FeedReceipt {
  try {
    return inTransaction(db, (): FeedReceipt => {
      const token = getToken(db, tokenId);
      const thresholds = getThresholds(db, token.collection_id);
      const result = applyFeed({ level: token.level, xp: token.xp, thresholds, amount });
      if (result.alreadyMax) {
        throw stateConflict("max_level_reached", "token " + tokenId + " is already at max level");
      }
      db.prepare(
        "UPDATE tokens SET level = ?, xp = ?, total_fed = total_fed + ?, total_consumed = total_consumed + ? " +
          "WHERE token_id = ?",
      ).run(result.level, result.xp, amount, result.consumed, tokenId);
      const info = db
        .prepare("INSERT INTO transitions (token_id, kind, amount, from_level, to_level, xp_after) VALUES (?, 'feed', ?, ?, ?, ?)")
        .run(tokenId, amount, token.level, result.level, result.xp);
      return {
        tokenId,
        level: result.level,
        xp: result.xp,
        consumed: result.consumed,
        transitions: result.transitions,
        commitSeq: Number(info.lastInsertRowid),
      };
    });
  } catch (err) {
    if (err instanceof Error && /SQLITE_BUSY|database is locked/i.test(err.message)) {
      throw resourceExhausted("database_busy", err.message);
    }
    throw err;
  }
}

export function resetToken(db: DB, tokenId: number, adminId: string): FeedReceipt {
  return inTransaction(db, (): FeedReceipt => {
    const token = getToken(db, tokenId);
    const adm = db
      .prepare("SELECT 1 AS ok FROM admins WHERE admin_id = ? AND collection_id = ?")
      .get(adminId, token.collection_id);
    if (!adm) {
      throw inputError("not_collection_admin", "admin " + adminId + " cannot reset collection " + token.collection_id);
    }
    db.prepare("UPDATE tokens SET level = 1, xp = 0 WHERE token_id = ?").run(tokenId);
    const info = db
      .prepare("INSERT INTO transitions (token_id, kind, amount, from_level, to_level, xp_after) VALUES (?, 'reset', 0, ?, 1, 0)")
      .run(tokenId, token.level);
    return { tokenId, level: 1, xp: 0, consumed: 0, transitions: 0, commitSeq: Number(info.lastInsertRowid) };
  });
}

export function getTokenState(db: DB, tokenId: number): { token: TokenRow; template: CollectionTemplate } {
  const token = getToken(db, tokenId);
  return { token, template: getTemplate(db, token.collection_id) };
}
