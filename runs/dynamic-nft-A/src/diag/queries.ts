import type { DatabaseSync } from "node:sqlite";

export interface FeedEventRow {
  seq: number;
  runId: string;
  collectionId: string;
  tokenId: string;
  amount: number;
  fromLevel: number;
  fromXp: number;
  toLevel: number;
  toXp: number;
  consumedDelta: number;
}

export interface LevelEventRow {
  seq: number;
  runId: string;
  collectionId: string;
  tokenId: string;
  fromLevel: number;
  toLevel: number;
  thresholdCost: number;
  atFeedSeq: number;
}

export class Diagnostics {
  constructor(private readonly db: DatabaseSync) {}

  tokenStatus(collectionId: string, tokenId: string) {
    const row = this.db
      .prepare(
        `SELECT collection_id, token_id, level, xp, consumed_xp, version
            FROM tokens WHERE collection_id = ? AND token_id = ?`,
      )
      .get(collectionId, tokenId);
    if (!row) return null;
    const r = row as Record<string, number | string>;
    return {
      collectionId: r.collection_id,
      tokenId: r.token_id,
      level: r.level,
      xp: r.xp,
      consumedXp: r.consumed_xp,
      version: r.version,
    };
  }

  feedHistory(collectionId: string, tokenId: string, limit = 100): FeedEventRow[] {
    const rows = this.db
      .prepare(
        `SELECT seq, run_id, collection_id, token_id, amount, from_level, from_xp,
                to_level, to_xp, consumed_delta
           FROM feed_events
          WHERE collection_id = ? AND token_id = ?
          ORDER BY seq ASC
          LIMIT ?`,
      )
      .all(collectionId, tokenId, limit) as Array<Record<string, number | string>>;
    return rows.map((r) => ({
      seq: Number(r.seq),
      runId: String(r.run_id),
      collectionId: String(r.collection_id),
      tokenId: String(r.token_id),
      amount: Number(r.amount),
      fromLevel: Number(r.from_level),
      fromXp: Number(r.from_xp),
      toLevel: Number(r.to_level),
      toXp: Number(r.to_xp),
      consumedDelta: Number(r.consumed_delta),
    }));
  }

  levelHistory(collectionId: string, tokenId: string, limit = 100): LevelEventRow[] {
    const rows = this.db
      .prepare(
        `SELECT seq, run_id, collection_id, token_id, from_level, to_level,
                threshold_cost, at_feed_seq
           FROM level_events
          WHERE collection_id = ? AND token_id = ?
          ORDER BY seq ASC
          LIMIT ?`,
      )
      .all(collectionId, tokenId, limit) as Array<Record<string, number | string>>;
    return rows.map((r) => ({
      seq: Number(r.seq),
      runId: String(r.run_id),
      collectionId: String(r.collection_id),
      tokenId: String(r.token_id),
      fromLevel: Number(r.from_level),
      toLevel: Number(r.to_level),
      thresholdCost: Number(r.threshold_cost),
      atFeedSeq: Number(r.at_feed_seq),
    }));
  }

  ledger(collectionId: string, tokenId: string) {
    const feedRow = this.db
      .prepare(
        "SELECT COALESCE(SUM(amount), 0) AS fed FROM feed_events WHERE collection_id = ? AND token_id = ?",
      )
      .get(collectionId, tokenId) as { fed: number };
    const consumedRow = this.db
      .prepare(
        "SELECT COALESCE(SUM(consumed_delta), 0) AS consumed FROM feed_events WHERE collection_id = ? AND token_id = ?",
      )
      .get(collectionId, tokenId) as { consumed: number };
    const token = this.tokenStatus(collectionId, tokenId);
    return {
      totalFed: Number(feedRow.fed),
      totalConsumed: Number(consumedRow.consumed),
      currentXp: token ? Number(token.xp) : null,
      balanced: token ? Number(feedRow.fed) === Number(consumedRow.consumed) + Number(token.xp) : null,
    };
  }
}

